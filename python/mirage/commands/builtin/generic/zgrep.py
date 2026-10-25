from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.generic.decompress import decompress_inputs
from mirage.commands.builtin.generic.grep import listing_mode, max_count
from mirage.commands.builtin.grep_binary import valid_utf8
from mirage.commands.builtin.grep_offsets import prefix_of
from mirage.commands.builtin.grep_pattern import (
    compile_pattern,
    line_pieces,
    line_selected,
    matcher_syntax,
    pattern_warnings,
    resolve_pattern,
)
from mirage.commands.builtin.grep_scan import exit_code_for
from mirage.commands.builtin.types import RegexSyntax
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
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.regex import LineRegex
from mirage.shell.bytes import byte_view, encode_text, text_view
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

# gzip 1.13's zgrep with no pattern, exit 2; zegrep and zfgrep exec
# zgrep, so they say the same. The host line also carries the
# script's line number and its $0 path, which name a file mirage
# does not have.
ZGREP_NO_PATTERN = "zgrep: missing pattern; try `zgrep --help' for help"


async def _read_plain(
    read: PolymorphicReadFn,
    path: PathSpec,
) -> bytes:
    return await materialize(normalized_read(read)(path))


@dataclass(frozen=True, slots=True)
class ZgrepFlags:
    """Parsed zgrep flags; the complete set zgrep honors."""

    ignore_case: bool
    invert: bool
    count: bool
    files_only: bool
    files_without_match: bool
    line_numbers: bool
    byte_offsets: bool
    fixed: bool
    syntax: RegexSyntax
    force_filename: bool
    suppress_filename: bool
    only_matching: bool
    quiet: bool
    whole_word: bool
    line_regexp: bool
    max_count: int | None


def parse_flags(fl: FlagView, never_match: bool) -> ZgrepFlags:
    """Convert the raw flag bag into ZgrepFlags, the only string-keyed reads.

    Args:
        fl (FlagView): spec-validated view over the raw flag kwargs.
        never_match (bool): zero-pattern sentinel from resolve_pattern; it is
            a regex, so it suppresses -F.
    """
    files_only, files_without_match = listing_mode(fl)
    return ZgrepFlags(
        ignore_case=fl.as_bool("ignore_case"),
        invert=fl.as_bool("invert_match"),
        count=fl.as_bool("count"),
        files_only=files_only,
        files_without_match=files_without_match,
        line_numbers=fl.as_bool("line_number"),
        byte_offsets=fl.as_bool("byte_offset"),
        fixed=fl.as_bool("fixed_strings") and not never_match,
        # zgrep is grep over decompressed bytes, so it reads a basic
        # expression unless -E or -P says otherwise, and refuses two
        # matchers as grep does; -G asks for the default.
        syntax=matcher_syntax(fl),
        force_filename=fl.as_bool("with_filename"),
        suppress_filename=fl.as_bool("no_filename"),
        only_matching=fl.as_bool("only_matching"),
        quiet=fl.as_bool("quiet"),
        whole_word=fl.as_bool("word_regexp"),
        line_regexp=fl.as_bool("line_regexp"),
        max_count=max_count(fl),
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
    # GNU grep 3.11 skips regex validation and selection under -m0.
    compiled = (
        None
        if f.max_count == 0
        else LineRegex([], "basic", utf8=utf8)
        if never_match
        else compile_pattern(
            byte_view(pattern, utf8),
            f.ignore_case,
            f.fixed,
            f.whole_word,
            f.syntax,
            utf8,
            f.line_regexp,
        )
    )
    multi = len(paths) > 1
    show_filename = f.force_filename or (multi and not f.suppress_filename)
    warnings = (
        b"" if compiled is None or never_match else pattern_warnings(compiled)
    )
    result = IOResult(exit_code=1, stderr=warnings or None)

    async def run() -> AsyncIterator[bytes]:
        any_match = False
        failed = False
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
            reader = AsyncLineIterator(body or b"")
            count = 0
            number = 0
            binary = False
            fname = (
                operand_label(p, GREP_STDIN_LABEL) if show_filename else None
            )
            try:
                while True:
                    offset = reader.position
                    raw = await reader.readline()
                    if raw is None:
                        break
                    number += 1
                    # Read through the trailer even after selection stops:
                    # a corrupt gzip remains zgrep's exit 2 beside a match.
                    if (
                        compiled is None
                        or (f.max_count is not None and count >= f.max_count)
                        or ((f.files_only or f.files_without_match) and count)
                    ):
                        continue
                    line = byte_view(raw, utf8)
                    # Whether the line is selected is its own question: an
                    # empty match selects it and gives -o nothing to print.
                    hit = line_selected(compiled, line) != f.invert
                    selected: list[tuple[int, str]] = []
                    if not hit:
                        pass
                    elif (
                        f.only_matching
                        and not f.invert
                        and not (f.files_only or f.files_without_match)
                    ):
                        selected = line_pieces(compiled, line)
                    else:
                        selected = [(0, line)]
                    if hit:
                        count += 1
                        any_match = True
                    for at, text in selected:
                        if not (
                            f.count
                            or f.files_only
                            or f.files_without_match
                            or f.quiet
                        ):
                            if utf8 and not valid_utf8(encode_text(text)):
                                binary = True
                            else:
                                byte_at = offset + (
                                    len(encode_text(line[:at])) if utf8 else at
                                )
                                prefix = (
                                    (fname + ":") if fname is not None else ""
                                )
                                prefix += prefix_of(
                                    number if f.line_numbers else None,
                                    byte_at if f.byte_offsets else None,
                                )
                                yield encode_text(
                                    prefix + text_view(text, utf8) + "\n"
                                )
            finally:
                await reader.discard()
            diagnostic = await io.materialize_stderr()
            if binary:
                diagnostic += encode_text(
                    f"grep: {operand_label(p, GREP_STDIN_LABEL)}: "
                    "binary file matches\n"
                )
            if diagnostic:
                result.stderr = await materialize(result.stderr) + diagnostic
            failed = failed or io.exit_code == 1
            result.exit_code = exit_code_for(any_match, failed, False)
            if compiled is None:
                if f.files_without_match:
                    yield encode_text(p.raw_path + "\n")
            elif not f.quiet:
                if f.files_only or f.files_without_match:
                    if bool(count) == f.files_only:
                        yield encode_text(p.raw_path + "\n")
                elif f.count:
                    prefix = fname + ":" if fname is not None else ""
                    yield encode_text(prefix + str(count) + "\n")

    return OutputStream(run(), partial(close_quietly, stdin)), result


__all__ = ["zgrep_generic"]
