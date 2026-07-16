import zlib
from collections.abc import AsyncIterator, Awaitable, Callable

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def extract_level(extra: dict) -> int:
    for n in range(9, 0, -1):
        if extra.get(str(n)):
            return n
    return zlib.Z_DEFAULT_COMPRESSION


async def _gzip_compress_stream(
    source: AsyncIterator[bytes],
    level: int,
) -> AsyncIterator[bytes]:
    compressor = zlib.compressobj(level, zlib.DEFLATED, zlib.MAX_WBITS | 16)
    async for chunk in source:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    tail = compressor.flush()
    if tail:
        yield tail


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


async def gzip(
    paths: list[PathSpec],
    *,
    read_bytes: Callable[..., Awaitable[bytes]],
    write_bytes: Callable[..., Awaitable[None]],
    unlink: Callable[..., Awaitable[None]],
    accessor: Accessor | None = None,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    decompress: bool = False,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    level: int = zlib.Z_DEFAULT_COMPRESSION,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        if decompress:
            source = _resolve_source(stdin,
                                     "gzip: (stdin): unexpected end of file")
            return _gzip_decompress_stream(source), IOResult()
        source = _resolve_source(stdin)
        return _gzip_compress_stream(source, level=level), IOResult()

    if to_stdout:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(accessor, p)
            if decompress:
                chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
            else:
                chunks.append(
                    zlib.compress(raw, level=level, wbits=zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, ByteSource] = {}
    for p in paths:
        raw = await read_bytes(accessor, p)
        stripped = p.mount_path
        if decompress:
            out_path = stripped.removesuffix(".gz") if stripped.endswith(
                ".gz") else stripped + ".out"
            out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        else:
            out_path = stripped + ".gz"
            out_data = zlib.compress(raw,
                                     level=level,
                                     wbits=zlib.MAX_WBITS | 16)
        await write_bytes(accessor, PathSpec.from_str_path(out_path), out_data)
        writes[out_path] = out_data
        if not keep:
            await unlink(accessor, p)
    return None, IOResult(writes=writes)


__all__ = ["gzip", "extract_level"]
