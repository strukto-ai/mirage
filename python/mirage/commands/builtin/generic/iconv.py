from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing

from mirage.commands.builtin.utils.stream import (
    never_opened,
    resolve_source,
    stdin_stream,
)
from mirage.commands.config import Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS, READ_FAILURES
from mirage.errors.fs import fs_strerror
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import merge_output, open_stream
from mirage.shell.bytes import byte_view, encode_text, from_byte_view
from mirage.types import PathSpec, PolymorphicReadFn


async def iconv_generic(
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
    read_stream: PolymorphicReadFn,
    write_bytes: Callable[..., Awaitable[None]],
) -> tuple[ByteSource | None, IOResult]:
    """Convert each operand in order through mirage-rs's iconv, as glibc
    2.41 converts.

    An input that cannot be opened is reported and skipped; one that opens
    and then refuses the read, a directory, ends the run.

    Args:
        paths (list[PathSpec]): input operands, empty for stdin.
        texts (list[str]): unused.
        ctx (Context): flags and stdin.
        read_stream (PolymorphicReadFn): reads one operand.
        write_bytes (Callable[..., Awaitable[None]]): writes ``-o``.
    """
    fl = FlagView(ctx.flags, spec=SPECS["iconv"])
    if fl.as_bool("list"):
        return open_stream("iconv", {"list": True}).finish(), IOResult()
    try:
        stream = open_stream(
            "iconv",
            {
                "from": byte_view(fl.as_str("from_code", "")),
                "to": byte_view(fl.as_str("to_code", "")),
                "omit": fl.as_bool("c"),
                "inputs": max(len(paths), 1),
            },
        )
    except StreamRefusal as refusal:
        stderr = from_byte_view(refusal.message) + b"\n"
        return None, IOResult(exit_code=1, stderr=stderr)
    read = stdin_stream(read_stream, ctx.stdin)
    operands: list[tuple[PathSpec | None, AsyncLineIterator]] = [
        (path, AsyncLineIterator(read(path))) for path in paths
    ] or [(None, AsyncLineIterator(resolve_source(ctx.stdin)))]
    io = IOResult()

    async def report(line: bytes) -> None:
        if line:
            io.exit_code = 1
            io.stderr = await materialize(io.stderr) + line

    async def read_input(index: int) -> bytes | None:
        await report(stream.take_stderr())
        path, reader = operands[index]
        try:
            return await reader.read_chunk()
        except FS_ERRORS as exc:
            if (
                path is None
                or isinstance(exc, READ_FAILURES)
                or not never_opened(reader, path, exc)
            ):
                line = f"error while reading the input: {fs_strerror(exc)}"
                stream.cancel()
            else:
                line = (
                    f"cannot open input file `{path.raw_path}': "
                    f"{fs_strerror(exc)}"
                )
            await report(encode_text(f"iconv: {line}\n"))
            return None

    async def output() -> AsyncIterator[bytes]:
        try:
            async with aclosing(merge_output(stream, read_input)) as out:
                async for chunk in out:
                    yield chunk
        except StreamRefusal as refusal:
            await report(from_byte_view(refusal.message) + b"\n")
            if refusal.output:
                yield refusal.output
        finally:
            for _, reader in operands:
                await reader.discard()
        await report(stream.take_stderr())
        if stream.status():
            io.exit_code = 1

    converted = output()
    output_path = fl.as_path("output")
    if output_path is not None:
        async with ByteSpool() as spool:
            await spool.fill(converted)
            await write_bytes(output_path, spool.stream())
        return None, io
    return converted, io


__all__ = ["iconv_generic"]
