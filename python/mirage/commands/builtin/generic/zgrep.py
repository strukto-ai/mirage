from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import aclosing
from functools import partial
from typing import cast

from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.builtin.generic.grep import GrepValues, listing_mode
from mirage.commands.builtin.grep_binary import GrepFlags
from mirage.commands.builtin.grep_pattern import (
    matcher_syntax,
    resolve_pattern,
)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.grep_select import WalkFilters
from mirage.commands.builtin.grep_stream import (
    open_grep,
    stream_config,
    stream_input,
)
from mirage.commands.builtin.utils.constants import (
    GREP_STDIN_LABEL,
    STDIN_OPERAND,
)
from mirage.commands.builtin.utils.links import LinkResolver
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import operand_label
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import OutputStream, close_quietly, ensure_stream
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.scan import scanned
from mirage.rs.stream import close_stream
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

# gzip 1.13's zgrep with no pattern, exit 2; zegrep and zfgrep exec
# zgrep, so they say the same. The host line also carries the
# script's line number and its $0 path, which name a file mirage
# does not have.
ZGREP_NO_PATTERN = "zgrep: missing pattern; try `zgrep --help' for help"


async def _read_plain(read: PolymorphicReadFn, path: PathSpec) -> bytes:
    return await materialize(normalized_read(read)(path))


def parse_flags(fl: FlagView, never_match: bool) -> GrepFlags:
    """Read zgrep's supported flags into the shared grep configuration.

    Args:
        fl (FlagView): The spec-bound flags.
        never_match (bool): An empty pattern file matches nothing.
    """
    files_only, files_without_match = listing_mode(fl)
    values = cast(GrepValues, scanned("grep", fl.texts("max_count")))
    count = values["max_count"]
    return GrepFlags(
        ignore_case=fl.as_bool("ignore_case"),
        invert=fl.as_bool("invert_match"),
        count_only=fl.as_bool("count"),
        files_only=files_only,
        files_without_match=files_without_match,
        line_numbers=fl.as_bool("line_number"),
        byte_offsets=fl.as_bool("byte_offset"),
        fixed_string=fl.as_bool("fixed_strings") and not never_match,
        syntax=matcher_syntax(fl),
        with_filename=fl.as_bool("with_filename"),
        no_filename=fl.as_bool("no_filename"),
        only_matching=fl.as_bool("only_matching"),
        quiet=fl.as_bool("quiet") and count != 0,
        whole_word=fl.as_bool("word_regexp"),
        line_regexp=fl.as_bool("line_regexp"),
        max_count=count,
        no_messages=False,
        recursive=False,
        after_context=None,
        before_context=None,
        binary_mode="binary",
        filters=WalkFilters(),
    )


async def zgrep_generic(
    paths: list[PathSpec],
    texts: Sequence[str] = (),
    flags: Mapping[str, FlagValue] | None = None,
    *,
    read: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    stat: StatFn | None = None,
    resolver: LinkResolver | None = None,
    utf8: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=SPECS["zgrep"])
    pattern, never_match = await resolve_pattern(
        texts,
        fl,
        partial(_read_plain, read),
        ZGREP_NO_PATTERN,
    )
    f = parse_flags(fl, never_match)
    stream, warnings = open_grep(
        stream_config(
            f, None if never_match or f.max_count == 0 else pattern, utf8
        )
    )
    show_filename = f.with_filename or (len(paths) > 1 and not f.no_filename)
    result = IOResult(exit_code=1, stderr=warnings or None)

    async def run() -> AsyncIterator[bytes]:
        any_match = False
        failed = False
        try:
            for p in paths or [STDIN_OPERAND]:
                body, io = await decompress_inputs(
                    [p],
                    read=read,
                    stdin=stdin,
                    to_stdout=True,
                    force=True,
                    quiet=True,
                    stat=stat,
                    resolver=resolver,
                )
                selected = IOResult(exit_code=1)
                output = stream_input(
                    ensure_stream(body or b""),
                    stream,
                    operand_label(p, GREP_STDIN_LABEL),
                    show_filename,
                    selected,
                    consume_all=True,
                    list_label=p.raw_path,
                )
                try:
                    async with aclosing(output):
                        async for chunk in output:
                            yield chunk
                finally:
                    any_match = any_match or selected.exit_code == 0
                    failed = (
                        failed or io.exit_code == 1 or selected.exit_code == 2
                    )
                    diagnostic = (
                        await io.materialize_stderr()
                        + await selected.materialize_stderr()
                    )
                    if diagnostic:
                        result.stderr = (
                            await materialize(result.stderr) + diagnostic
                        )
                    result.exit_code = exit_code_for(any_match, failed, False)
        finally:
            await close_stream(stream)

    async def close() -> None:
        await close_stream(stream)
        await close_quietly(stdin)

    return OutputStream(run(), close), result


__all__ = ["zgrep_generic"]
