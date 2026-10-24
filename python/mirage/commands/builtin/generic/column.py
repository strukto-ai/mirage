from collections.abc import Mapping
from dataclasses import dataclass

from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.stream import chain_output, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import PathSpec, ReadStreamFn


@dataclass(frozen=True, slots=True)
class ColumnFlags:
    table: bool = False
    separator: str | None = None
    output_separator: str = "  "


def parse_flags(flags: Mapping[str, FlagValue]) -> ColumnFlags:
    fl = FlagView(flags, spec=SPECS["column"])
    return ColumnFlags(
        table=fl.as_bool("t"),
        separator=fl.as_str("s"),
        output_separator=fl.as_str("o", "  "),
    )


async def column_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run util-linux column over every operand, or stdin without one;
    mirrors columnGeneric.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by column.
        ctx (Context): Flags, stdin and ``COLUMNS`` from the dispatcher.
        stream (ReadStreamFn): Bound reader called as ``stream(path)``.
    """
    parsed = parse_flags(ctx.flags)
    separator = parsed.separator
    sources: list[ByteSource] = [await materialize(stream(p)) for p in paths]
    engine = open_stream(
        "column",
        {
            "table": parsed.table,
            "separator": None if separator is None else byte_view(separator),
            "output_separator": byte_view(parsed.output_separator),
            "columns": (ctx.env or {}).get("COLUMNS"),
            "inputs": max(1, len(sources)),
        },
    )
    return chain_output(engine, sources or [ctx.stdin or b""]), IOResult()


__all__ = ["column_generic"]
