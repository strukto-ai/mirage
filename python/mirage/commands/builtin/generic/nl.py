import re
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.operands import (merge_split_errors,
                                                    normalized_read,
                                                    split_readable)
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec, PolymorphicReadFn, StatFn


@dataclass(frozen=True, slots=True)
class NlFlags:
    body_numbering_raw: str | None = None
    start_raw: str | None = None
    increment_raw: str | None = None
    width_raw: str | None = None
    separator: str | None = None
    footer_numbering_raw: str | None = None
    header_numbering_raw: str | None = None
    join_blank_lines_raw: str | None = None
    number_format: str = "rn"
    delimiter: str = "\\:"
    no_renumber: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> NlFlags:
    fl = FlagView(flags, spec=SPECS["nl"])
    return NlFlags(
        body_numbering_raw=fl.as_str("body_numbering"),
        start_raw=fl.as_str("starting_line_number"),
        increment_raw=fl.as_str("line_increment"),
        width_raw=fl.as_str("number_width"),
        separator=fl.as_str("number_separator"),
        footer_numbering_raw=fl.as_str("footer_numbering"),
        header_numbering_raw=fl.as_str("header_numbering"),
        join_blank_lines_raw=fl.as_str("join_blank_lines"),
        number_format=fl.as_str("number_format") or "rn",
        delimiter=fl.as_str("section_delimiter") or "\\:",
        no_renumber=fl.as_bool("no_renumber"),
    )


def _should_number(line: str, numbering: str,
                   pattern: re.Pattern[str] | None) -> bool:
    if numbering == "n":
        return False
    if numbering == "a":
        return True
    if numbering == "p" and pattern is not None:
        return pattern.search(line) is not None
    return bool(line.strip())


def _section_delimiters(delimiter: str) -> dict[str, str]:
    """Map each logical-page delimiter line to the section it opens.

    GNU pads a one-character ``-d`` with ``:`` as its second character, and
    an empty ``-d`` disables delimiter matching entirely.

    Args:
        delimiter (str): The ``-d``/``--section-delimiter`` argument.
    """
    if not delimiter:
        return {}
    pair = delimiter if len(delimiter) > 1 else delimiter + ":"
    return {pair * 3: "header", pair * 2: "body", pair: "footer"}


@dataclass(frozen=True, slots=True)
class NlConfig:
    numbering: dict[str, str]
    patterns: dict[str, re.Pattern[str] | None]
    start: int
    increment: int
    width: int
    separator: str
    number_format: str
    delimiters: dict[str, str]
    join_blank_lines: int
    no_renumber: bool


@dataclass(slots=True)
class NlState:
    number: int
    section: str = "body"
    blank_run: int = 0


def _format_number(number: int, width: int, number_format: str) -> str:
    if number_format == "ln":
        return str(number).ljust(width)
    if number_format == "rz":
        return str(number).zfill(width)
    return str(number).rjust(width)


def _render_line(line: str, config: NlConfig, state: NlState) -> bytes:
    section = config.delimiters.get(line)
    if section is not None:
        state.section = section
        state.blank_run = 0
        if not config.no_renumber:
            state.number = config.start
        # GNU writes an empty line in place of the delimiter itself.
        return b"\n"
    numbering = config.numbering[state.section]
    pattern = config.patterns[state.section]
    should_number = _should_number(line, numbering, pattern)
    if numbering == "a" and not line:
        state.blank_run += 1
        should_number = state.blank_run >= config.join_blank_lines
        if should_number:
            state.blank_run = 0
    else:
        state.blank_run = 0
    if should_number:
        prefix = _format_number(state.number, config.width,
                                config.number_format)
        state.number += config.increment
        return f"{prefix}{config.separator}{line}\n".encode()
    return f"{' ' * config.width}{config.separator}{line}\n".encode()


async def _nl_stream(
    source: AsyncIterator[bytes],
    config: NlConfig,
    state: NlState,
) -> AsyncIterator[bytes]:
    async for raw_line in AsyncLineIterator(source):
        line = raw_line.decode(errors="replace")
        yield _render_line(line, config, state)


async def _nl_multi(
    paths: list[PathSpec],
    read_stream: Callable[..., AsyncIterator[bytes]],
    config: NlConfig,
) -> AsyncIterator[bytes]:
    state = NlState(config.start)
    for p in paths:
        async for rendered in _nl_stream(read_stream(p), config, state):
            yield rendered


def _parse_numbering(raw: str) -> tuple[str, re.Pattern[str] | None]:
    if raw.startswith("p"):
        return "p", re.compile(raw[1:])
    return raw, None


async def nl(
    paths: list[PathSpec],
    *,
    read_stream: Callable[..., AsyncIterator[bytes]],
    stdin: ByteSource | None = None,
    body_numbering_raw: str | None = None,
    start_raw: str | None = None,
    increment_raw: str | None = None,
    width_raw: str | None = None,
    separator: str | None = None,
    footer_numbering_raw: str | None = None,
    header_numbering_raw: str | None = None,
    join_blank_lines_raw: str | None = None,
    number_format: str = "rn",
    delimiter: str = "\\:",
    no_renumber: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    body_numbering, body_pattern = _parse_numbering(body_numbering_raw or "t")
    footer_numbering, footer_pattern = _parse_numbering(footer_numbering_raw
                                                        or "n")
    header_numbering, header_pattern = _parse_numbering(header_numbering_raw
                                                        or "n")
    start = int(start_raw) if start_raw is not None else 1
    increment = int(increment_raw) if increment_raw is not None else 1
    width = int(width_raw) if width_raw is not None else 6
    config = NlConfig(
        numbering={
            "body": body_numbering,
            "footer": footer_numbering,
            "header": header_numbering,
        },
        patterns={
            "body": body_pattern,
            "footer": footer_pattern,
            "header": header_pattern,
        },
        start=start,
        increment=increment,
        width=width,
        separator=separator if separator is not None else "\t",
        number_format=number_format,
        delimiters=_section_delimiters(delimiter),
        join_blank_lines=int(join_blank_lines_raw or "1"),
        no_renumber=no_renumber,
    )

    if paths:
        return _nl_multi(paths, read_stream, config), IOResult()
    source = _resolve_source(stdin, "nl: missing operand")
    return _nl_stream(source, config, NlState(start)), IOResult()


async def nl_generic(
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
    stat: StatFn,
    stream: PolymorphicReadFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run nl over resolved operands; mirrors nlGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by nl.
        opts (CommandOpts): Flags and stdin from the dispatcher.
        stat (StatFn): Bound stat called as ``stat(path)``.
        stream (PolymorphicReadFn): Bound reader called as
            ``stream(path)``.
    """
    parsed = parse_flags(opts.flags)
    readable, err = await split_readable(paths, stat, "nl")
    if err and not readable:
        return None, IOResult(exit_code=1, stderr=err)
    return await merge_split_errors(
        await nl(readable,
                 read_stream=normalized_read(stream),
                 stdin=opts.stdin,
                 body_numbering_raw=parsed.body_numbering_raw,
                 start_raw=parsed.start_raw,
                 increment_raw=parsed.increment_raw,
                 width_raw=parsed.width_raw,
                 separator=parsed.separator,
                 footer_numbering_raw=parsed.footer_numbering_raw,
                 header_numbering_raw=parsed.header_numbering_raw,
                 join_blank_lines_raw=parsed.join_blank_lines_raw,
                 number_format=parsed.number_format,
                 delimiter=parsed.delimiter,
                 no_renumber=parsed.no_renumber), err)


__all__ = ["nl", "nl_generic"]
