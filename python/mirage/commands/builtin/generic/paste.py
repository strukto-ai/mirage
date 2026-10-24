from collections.abc import AsyncIterator
from contextlib import aclosing

from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream import (
    is_stdin,
    never_opened,
    resolve_source,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.rs.stream import merge_output, open_stream
from mirage.shell.bytes import byte_view, encode_text
from mirage.types import JsonValue, PathSpec, PolymorphicReadFn


async def paste_generic(
    paths: list[PathSpec],
    *,
    read_stream: PolymorphicReadFn,
    stdin: ByteSource | None = None,
    delimiters: str = "\t",
    serial: bool = False,
    zero_terminated: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    read = normalized_read(read_stream)
    shared = AsyncLineIterator(resolve_source(stdin))
    operands = paths or [PathSpec.from_str_path("-")]
    inputs = [
        (p, shared if is_stdin(p) else AsyncLineIterator(read(p)))
        for p in operands
    ]
    config: dict[str, JsonValue] = {
        "delimiters": byte_view(delimiters),
        "serial": serial,
        "zero_terminated": zero_terminated,
    }
    io = IOResult()
    return _paste_stream(inputs, config, io), io


async def _paste_stream(
    inputs: list[tuple[PathSpec, AsyncLineIterator]],
    config: dict[str, JsonValue],
    io: IOResult,
) -> AsyncIterator[bytes]:
    """Open every operand, as GNU does before it reads, then paste them.

    A failed read is reported, exit 1, and its operand reads as ended. One
    that never opened ends the run before any line is written, and under
    -s is left out.

    Args:
        inputs (list[tuple[PathSpec, AsyncLineIterator]]): each operand,
            ``-`` for no operand, with its reader; every stdin operand
            shares one.
        config (dict[str, JsonValue]): the ``paste`` engine's options.
        io (IOResult): where a failed read is reported.
    """
    errors: list[str] = []

    def report(path: PathSpec, exc: BaseException) -> None:
        errors.append(fs_error_line("paste", path, exc))
        io.stderr, io.exit_code = encode_text("".join(errors)), 1

    readers = list(dict.fromkeys(reader for _, reader in inputs))
    try:
        opened: list[tuple[PathSpec, AsyncLineIterator]] = []
        for path, reader in inputs:
            try:
                if not is_stdin(path):
                    await reader.peek()
            except FS_ERRORS as exc:
                report(path, exc)
                if never_opened(reader, path, exc):
                    if not config["serial"]:
                        return
                    continue
            opened.append((path, reader))
        sources = list(dict.fromkeys(reader for _, reader in opened))
        names = {reader: path for path, reader in reversed(opened)}
        config["inputs"] = [sources.index(reader) for _, reader in opened]

        async def pull(index: int) -> bytes | None:
            try:
                return await sources[index].read_chunk()
            except FS_ERRORS as exc:
                report(names[sources[index]], exc)
                return None

        stream = open_stream("paste", config)
        async with aclosing(merge_output(stream, pull)) as output:
            async for chunk in output:
                yield chunk
    finally:
        for reader in readers:
            await reader.discard()


__all__ = ["paste_generic"]
