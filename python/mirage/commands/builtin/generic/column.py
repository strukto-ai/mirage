from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import aclosing
from dataclasses import dataclass

from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.scan import refused
from mirage.rs.stream import OpenStream, chain_output, open_stream
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec, ReadStreamFn


@dataclass(frozen=True, slots=True)
class ColumnFlags:
    table: bool = False
    separator: str | None = None
    output_separator: str = "  "
    output_width: str | None = None
    fillrows: bool = False
    json: bool = False
    table_name: str | None = None
    names: str | None = None
    column_specs: tuple[str, ...] = ()
    order: str | None = None
    limit: str | None = None
    right: str | None = None
    hide: str | None = None
    truncate: str | None = None
    wrap: str | None = None
    noextreme: str | None = None
    no_headings: bool = False
    maxout: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> ColumnFlags:
    fl = FlagView(flags, spec=SPECS["column"])
    return ColumnFlags(
        table=fl.as_bool("table"),
        separator=fl.as_str("separator"),
        output_separator=fl.as_str("output_separator", "  "),
        output_width=fl.as_str("output_width"),
        fillrows=fl.as_bool("fillrows"),
        json=fl.as_bool("json"),
        table_name=fl.as_str("table_name"),
        names=fl.as_str("table_columns"),
        column_specs=tuple(fl.as_list("table_column")),
        order=fl.as_str("table_order"),
        limit=fl.as_str("table_columns_limit"),
        right=fl.as_str("table_right"),
        hide=fl.as_str("table_hide"),
        truncate=fl.as_str("table_truncate"),
        wrap=fl.as_str("table_wrap"),
        noextreme=fl.as_str("table_noextreme"),
        no_headings=fl.as_bool("table_noheadings"),
        maxout=fl.as_bool("table_maxout"),
    )


def _bytes_of(text: str | None) -> str | None:
    return None if text is None else byte_view(text)


def stream_config(
    parsed: ColumnFlags, columns: str | None, inputs: int
) -> dict[str, JsonValue]:
    """What mirage-rs's column takes for one invocation.

    Args:
        parsed (ColumnFlags): the options.
        columns (str | None): the session's ``COLUMNS``.
        inputs (int): how many inputs it reads.
    """
    return {
        "table": parsed.table,
        "separator": _bytes_of(parsed.separator),
        "output_separator": byte_view(parsed.output_separator),
        "columns": columns,
        "inputs": inputs,
        "output_width": _bytes_of(parsed.output_width),
        "fillrows": parsed.fillrows,
        "json": parsed.json,
        "table_name": _bytes_of(parsed.table_name),
        "names": _bytes_of(parsed.names),
        "column_specs": [byte_view(text) for text in parsed.column_specs],
        "order": _bytes_of(parsed.order),
        "limit": _bytes_of(parsed.limit),
        "right": _bytes_of(parsed.right),
        "hide": _bytes_of(parsed.hide),
        "truncate": _bytes_of(parsed.truncate),
        "wrap": _bytes_of(parsed.wrap),
        "noextreme": _bytes_of(parsed.noextreme),
        "no_headings": parsed.no_headings,
        "maxout": parsed.maxout,
    }


async def _columned(
    engine: OpenStream, sources: Sequence[ByteSource], io: IOResult
) -> AsyncIterator[bytes]:
    """The engine's output, with what it refuses once it has read its
    input settled on ``io``.

    Args:
        engine (OpenStream): the column stream.
        sources (Sequence[ByteSource]): its inputs, in order.
        io (IOResult): the result to settle.
    """
    try:
        async with aclosing(chain_output(engine, sources)) as output:
            async for chunk in output:
                yield chunk
    except StreamRefusal as refusal:
        settled = refused(refusal)
        io.exit_code = settled.exit_code
        io.stderr = settled.stderr


async def column_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    stream: ReadStreamFn,
) -> tuple[ByteSource | None, IOResult]:
    """Run util-linux column over every operand, or stdin without one;
    mirrors columnGeneric. Output is never colored.

    Args:
        paths (list[PathSpec]): Glob-resolved operands, empty for stdin.
        texts (list[str]): Non-path words, unused by column.
        ctx (Context): Flags, stdin and ``COLUMNS`` from the dispatcher.
        stream (ReadStreamFn): Bound reader called as ``stream(path)``.
    """
    parsed = parse_flags(ctx.flags)
    sources: list[ByteSource] = [stream(p) for p in paths]
    try:
        engine = open_stream(
            "column",
            stream_config(
                parsed, (ctx.env or {}).get("COLUMNS"), max(1, len(sources))
            ),
        )
    except StreamRefusal as refusal:
        return None, refused(refusal)
    io = IOResult()
    return _columned(engine, sources or [ctx.stdin or b""], io), io


__all__ = ["column_generic"]
