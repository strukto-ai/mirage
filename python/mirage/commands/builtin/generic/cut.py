from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.cut_ranges import cut_stream, parse_ranges
from mirage.commands.builtin.utils.operands import (merge_split_errors,
                                                    normalized_read,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import (resolve_source, stdin_stat,
                                                  stdin_stream)
from mirage.commands.config import CommandOpts
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn

WHITESPACE_ARGS = ("trimmed", )


@dataclass(frozen=True, slots=True)
class CutFlags:
    ranges: str
    mode: str
    delimiter: str = "\t"
    complement: bool = False
    only_delimited: bool = False
    whitespace: str | None = None
    no_partial: bool = False
    output_delimiter: str | None = None
    zero_terminated: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> CutFlags:
    fl = FlagView(flags, spec=SPECS["cut"])
    bytes_range = fl.as_str("bytes")
    chars_range = fl.as_str("characters")
    fields_range = fl.as_str("F") or fl.as_str("fields")
    modes = [("bytes", bytes_range), ("characters", chars_range),
             ("fields", fields_range)]
    selected = [(mode, value) for mode, value in modes if value is not None]
    if not selected:
        raise ValueError(
            "cut: you must specify a list of bytes, characters, or fields")
    if len(selected) > 1:
        raise ValueError("cut: only one type of list may be specified")
    mode, ranges = selected[0]
    raw_whitespace = fl.raw("whitespace_delimited")
    whitespace: str | None = None
    if fl.as_bool("w") or fl.as_str("F") is not None or raw_whitespace is True:
        whitespace = "default"
    elif isinstance(raw_whitespace, str):
        # One candidate, so ARGMATCH can only match or not match here:
        # a prefix of `trimmed` resolves to it, and the refusal keeps
        # cut's own one-line wording (no candidate block). GNU cut has no
        # such option, so there is nothing to measure this against: the
        # empty word reaching the sole candidate as ACCEPTED is what the
        # general rule says, not a probed answer. It stays the general
        # rule rather than a special case.
        if not isinstance(argmatch(raw_whitespace, WHITESPACE_ARGS),
                          ArgmatchMatch):
            raise ValueError(f"cut: invalid argument "
                             f"'{quote_text(raw_whitespace)}' for "
                             "'--whitespace-delimited'")
        whitespace = "trimmed"
    if whitespace is not None and mode != "fields":
        raise ValueError("cut: '-w' is only meaningful with fields")
    output_delimiter = (fl.as_str("args_O") or fl.as_str("output_delimiter"))
    if fl.as_str("F") is not None and output_delimiter is None:
        output_delimiter = " "
    explicit_delimiter = fl.as_str("delimiter")
    if explicit_delimiter is not None and len(explicit_delimiter) != 1:
        raise ValueError("cut: the delimiter must be a single character")
    return CutFlags(
        ranges=ranges,
        mode=mode,
        delimiter=explicit_delimiter or "\t",
        complement=fl.as_bool("complement"),
        only_delimited=fl.as_bool("only_delimited"),
        whitespace=whitespace,
        no_partial=fl.as_bool("no_partial"),
        output_delimiter=output_delimiter,
        zero_terminated=fl.as_bool("zero_terminated"),
    )


async def cut(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    flags: Mapping[str, FlagValue] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(flags or {})
        ranges = parse_ranges(parsed.ranges, parsed.mode)
    except (TypeError, ValueError) as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    read_stream = stdin_stream(read_stream, stdin)
    if paths:
        outputs = [
            cut_stream(read_stream(path),
                       ranges=ranges,
                       mode=parsed.mode,
                       delimiter=parsed.delimiter,
                       complement=parsed.complement,
                       only_delimited=parsed.only_delimited,
                       whitespace=parsed.whitespace,
                       no_partial=parsed.no_partial,
                       output_delimiter=parsed.output_delimiter,
                       zero_terminated=parsed.zero_terminated)
            for path in paths
        ]
        return async_chain(*outputs), IOResult()
    source = resolve_source(stdin, "cut: missing operand")
    return cut_stream(source,
                      ranges=ranges,
                      mode=parsed.mode,
                      delimiter=parsed.delimiter,
                      complement=parsed.complement,
                      only_delimited=parsed.only_delimited,
                      whitespace=parsed.whitespace,
                      no_partial=parsed.no_partial,
                      output_delimiter=parsed.output_delimiter,
                      zero_terminated=parsed.zero_terminated), IOResult()


async def cut_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run cut over resolved operands; mirrors cutGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by cut.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    readable, err = await split_readable(paths, stdin_stat(stat), "cut")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await cut(readable,
                  read_stream=normalized_read(stream),
                  stdin=opts.stdin,
                  flags=opts.flags), err)


__all__ = ["cut", "cut_generic"]
