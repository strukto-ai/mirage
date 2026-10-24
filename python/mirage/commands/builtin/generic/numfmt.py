from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.io.stream import OutputStream, close_quietly
from mirage.io.types import ByteSource, IOResult
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import (
    OpenStream,
    close_stream,
    open_stream,
    stream_output_chunks,
)
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue


async def numfmt_generic(
    *texts: str,
    stdin: ByteSource | None = None,
    to_mode: str = "none",
    from_mode: str = "none",
    suffix: str = "",
    grouping: bool = False,
    fields: list[str] | None = None,
    delimiters: list[str] | None = None,
    headers: list[str] | None = None,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    # mirage's one locale is C, whose thousands separator is empty, so
    # --grouping groups nothing; GNU still refuses it beside a --to scale.
    if grouping and to_mode != "none":
        return None, IOResult(
            exit_code=1,
            stderr=b"numfmt: grouping cannot be combined with --to\n",
        )
    config: dict[str, JsonValue] = {
        "to": to_mode,
        "from": from_mode,
        "suffix": byte_view(suffix),
        "operands": [byte_view(text) for text in texts],
        "fields": [byte_view(text) for text in fields or []],
        "delimiters": [byte_view(text) for text in delimiters or []],
        "headers": [byte_view(text) for text in headers or []],
        "zero_terminated": zero_terminated,
    }
    try:
        stream = open_stream("numfmt", config)
    except StreamRefusal as refusal:
        return None, IOResult(
            exit_code=1, stderr=f"{refusal.message}\n".encode()
        )
    io = IOResult()
    source = b"" if texts or stdin is None else stdin
    return _converted(stream, source, io), io


def _converted(
    stream: OpenStream, source: ByteSource, io: IOResult
) -> OutputStream:
    """The records converted; a refusal stops after the ones before it.
    Closing it releases the stream and, unread, the records.

    Args:
        stream (OpenStream): the opened numfmt stream.
        source (ByteSource): the records, empty when operands are given.
        io (IOResult): takes the refusal's exit 2 and line.
    """
    started = False

    async def output() -> AsyncIterator[bytes]:
        nonlocal started
        started = True
        try:
            async with aclosing(stream_output_chunks(stream, source)) as parts:
                async for part in parts:
                    yield part
        except StreamRefusal as refusal:
            io.exit_code, io.stderr = 2, f"{refusal.message}\n".encode()
            if refusal.output:
                yield refusal.output

    async def close() -> None:
        await close_stream(stream)
        if not started:
            await close_quietly(source)

    return OutputStream(output(), close)


__all__ = ["numfmt_generic"]
