import re
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _should_number(line: str, numbering: str,
                   pattern: re.Pattern[str] | None) -> bool:
    if numbering == "n":
        return False
    if numbering == "a":
        return True
    if numbering == "p" and pattern is not None:
        return pattern.search(line) is not None
    return bool(line.strip())


@dataclass(frozen=True, slots=True)
class NlConfig:
    numbering: dict[str, str]
    patterns: dict[str, re.Pattern[str] | None]
    start: int
    increment: int
    width: int
    separator: str
    number_format: str
    delimiter: str
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


def _render_line(line: str, config: NlConfig, state: NlState) -> bytes | None:
    delimiters = {
        config.delimiter * 3: "header",
        config.delimiter * 2: "body",
        config.delimiter: "footer",
    }
    if line in delimiters:
        state.section = delimiters[line]
        state.blank_run = 0
        if not config.no_renumber:
            state.number = config.start
        return None
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
        rendered = _render_line(line, config, state)
        if rendered is not None:
            yield rendered


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
        delimiter=delimiter,
        join_blank_lines=int(join_blank_lines_raw or "1"),
        no_renumber=no_renumber,
    )

    if paths:
        return _nl_multi(paths, read_stream, config), IOResult()
    source = _resolve_source(stdin, "nl: missing operand")
    return _nl_stream(source, config, NlState(start)), IOResult()


__all__ = ["nl"]
