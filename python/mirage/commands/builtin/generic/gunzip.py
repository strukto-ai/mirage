import zlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _gzip_decompress_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16)
    async for chunk in source:
        decompressed = decompressor.decompress(chunk)
        if decompressed:
            yield decompressed
    tail = decompressor.flush()
    if tail:
        yield tail


async def gunzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    accessor: object = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    test_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        source = _resolve_source(stdin, "gunzip: missing input")
        return _gzip_decompress_stream(source), IOResult()

    if test_only:
        for p in paths:
            raw = await read_bytes(accessor, p)
            zlib.decompress(raw, zlib.MAX_WBITS | 16)
        return None, IOResult()

    if to_stdout:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(accessor, p)
            chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, bytes] = {}
    for p in paths:
        raw = await read_bytes(accessor, p)
        stripped = p.strip_prefix
        out_path = stripped.removesuffix(".gz") if stripped.endswith(
            ".gz") else stripped + ".out"
        out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        await write_bytes(accessor, out_path, out_data)
        writes[out_path] = out_data
        if not keep:
            await unlink(accessor, p)
    return None, IOResult(writes=writes)


__all__ = ["gunzip"]
