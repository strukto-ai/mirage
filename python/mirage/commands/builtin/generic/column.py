from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.lines import join_file_lines, split_lines
from mirage.commands.builtin.utils.stream import read_stdin_async
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec, ReadStreamFn
from mirage.utils.width import advance_column, is_space, text_width

DEFAULT_WIDTH = 80


def _entries(text: str) -> list[str]:
    """The input lines util-linux ``column`` lays out: blank ones dropped."""
    return [
        line
        for line in split_lines(text)
        if not all(is_space(ch) for ch in line)
    ]


def _output_width(env: Mapping[str, str] | None) -> int:
    """``COLUMNS`` when it is a positive number, else 80: stdout is no tty."""
    raw = (env or {}).get("COLUMNS", "")
    return (
        int(raw)
        if raw.isascii() and raw.isdigit() and int(raw) > 0
        else DEFAULT_WIDTH
    )


def _fill_columns(text: str, width: int) -> str:
    """Lay entries down the columns, util-linux ``column``'s default mode.

    Each column is the widest entry rounded up to the next tab stop, as
    many columns as fit the width (at least one), and a gap is tabs to
    the next column start.

    Args:
        text (str): The whole input.
        width (int): The output width.
    """
    entries = _entries(text)
    if not entries:
        return ""
    stop = advance_column(max(text_width(e) for e in entries), "\t")
    rows = -(-len(entries) // max(1, width // stop))
    out: list[str] = []
    for row in range(rows):
        line, at, end = "", 0, stop
        for index in range(row, len(entries), rows):
            line += entries[index]
            at += text_width(entries[index])
            if index + rows >= len(entries):
                break
            while advance_column(at, "\t") <= end:
                line += "\t"
                at = advance_column(at, "\t")
            end += stop
        out.append(line)
    return "\n".join(out) + "\n"


def _table_format(text: str, separator: str | None, output_sep: str) -> str:
    rows = [
        line.split(separator) if separator else line.split()
        for line in _entries(text)
    ]
    if not rows:
        return ""
    widths = [0] * max(len(r) for r in rows)
    for row in rows:
        for idx, cell in enumerate(row):
            widths[idx] = max(widths[idx], text_width(cell))
    out: list[str] = []
    for row in rows:
        parts = [
            cell + " " * (widths[idx] - text_width(cell))
            if idx < len(row) - 1
            else cell
            for idx, cell in enumerate(row)
        ]
        out.append(output_sep.join(parts))
    return "\n".join(out) + "\n"


async def column(
    paths: list[PathSpec],
    *,
    stream: ReadStreamFn,
    stdin: ByteSource | None = None,
    table: bool = False,
    separator: str | None = None,
    output_separator: str | None = None,
    env: Mapping[str, str] | None = None,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        # Every operand is read, as one run of lines in which a file's last
        # line ends where the next file begins.
        raw = join_file_lines(
            [await materialize(stream(p)) for p in paths], b"\n"
        )
    else:
        stdin_raw = await read_stdin_async(stdin)
        raw = stdin_raw if stdin_raw is not None else b""
    text = raw.decode(errors="replace")
    if table:
        out = _table_format(
            text,
            separator,
            output_separator if output_separator is not None else "  ",
        )
    else:
        out = _fill_columns(text, _output_width(env))
    return out.encode(), IOResult()


__all__ = ["column"]


@dataclass(frozen=True, slots=True)
class ColumnFlags:
    table: bool = False
    separator: str | None = None
    output_separator: str | None = None


def parse_flags(flags: Mapping[str, FlagValue]) -> ColumnFlags:
    fl = FlagView(flags, spec=SPECS["column"])
    return ColumnFlags(
        table=fl.as_bool("t"),
        separator=fl.as_str("s"),
        output_separator=fl.as_str("o"),
    )


async def column_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
) -> tuple[ByteSource | None, IOResult]:
    parsed = parse_flags(ctx.flags)
    return await column(
        paths,
        stream=stream,
        stdin=ctx.stdin,
        table=parsed.table,
        separator=parsed.separator,
        output_separator=parsed.output_separator,
        env=ctx.env,
    )
