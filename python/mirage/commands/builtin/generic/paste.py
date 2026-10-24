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
from mirage.rs.stream import merge_output, open_stream, run_stream
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
    """Paste the operands. In rows every operand opens before any is read,
    as GNU opens them, and one that never opened ends the run before any
    line is written; under -s each opens when its turn comes, and one that
    never opened is left out. A failed read is reported, exit 1, and its
    operand reads as ended.

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

    async def opened(path: PathSpec, reader: AsyncLineIterator) -> bool:
        try:
            if not is_stdin(path):
                await reader.peek()
        except FS_ERRORS as exc:
            report(path, exc)
            return not never_opened(reader, path, exc)
        return True

    async def pull(path: PathSpec, reader: AsyncLineIterator) -> bytes | None:
        try:
            return await reader.read_chunk()
        except FS_ERRORS as exc:
            report(path, exc)
            return None

    async def records(
        path: PathSpec, reader: AsyncLineIterator
    ) -> AsyncIterator[bytes]:
        while (chunk := await pull(path, reader)) is not None:
            yield chunk

    try:
        if config["serial"]:
            for path, reader in inputs:
                if await opened(path, reader):
                    one: dict[str, JsonValue] = {**config, "inputs": [0]}
                    async with aclosing(
                        run_stream("paste", one, records(path, reader))
                    ) as output:
                        async for chunk in output:
                            yield chunk
            return
        for path, reader in inputs:
            if not await opened(path, reader):
                return
        sources = list(dict.fromkeys(reader for _, reader in inputs))
        names = {reader: path for path, reader in reversed(inputs)}
        config["inputs"] = [sources.index(reader) for _, reader in inputs]

        async def read(index: int) -> bytes | None:
            return await pull(names[sources[index]], sources[index])

        stream = open_stream("paste", config)
        async with aclosing(merge_output(stream, read)) as output:
            async for chunk in output:
                yield chunk
    finally:
        for reader in dict.fromkeys(reader for _, reader in inputs):
            await reader.discard()


__all__ = ["paste_generic"]
