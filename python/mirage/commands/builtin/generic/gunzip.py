import zlib
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass

from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
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
    stdin: ByteSource | None = None,
    keep: bool = False,
    force: bool = False,
    to_stdout: bool = False,
    test_only: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        source = _resolve_source(stdin,
                                 "gunzip: (stdin): unexpected end of file")
        return _gzip_decompress_stream(source), IOResult()

    if test_only:
        for p in paths:
            raw = await read_bytes(p)
            zlib.decompress(raw, zlib.MAX_WBITS | 16)
        return None, IOResult()

    if to_stdout:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(p)
            chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, ByteSource] = {}
    for p in paths:
        raw = await read_bytes(p)
        stripped = p.mount_path
        out_path = stripped.removesuffix(".gz") if stripped.endswith(
            ".gz") else stripped + ".out"
        out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        await write_bytes(PathSpec.from_str_path(out_path), out_data)
        writes[out_path] = out_data
        if not keep:
            await unlink(p)
    return None, IOResult(writes=writes)


__all__ = ["gunzip"]


@dataclass(frozen=True, slots=True)
class GunzipFlags:
    keep: bool = False
    force: bool = False
    to_stdout: bool = False
    test_only: bool = False


def parse_flags(flags: Mapping[str, FlagValue]) -> GunzipFlags:
    fl = FlagView(flags, spec=SPECS["gunzip"])
    return GunzipFlags(
        keep=fl.as_bool("k"),
        force=fl.as_bool("f"),
        to_stdout=fl.as_bool("c"),
        test_only=fl.as_bool("t"),
    )


async def gunzip_generic(paths, texts, opts: CommandOpts, read_bytes,
                         write_bytes, unlink):
    parsed = parse_flags(opts.flags)
    return await gunzip(paths,
                        read_bytes=read_bytes,
                        write_bytes=write_bytes,
                        unlink=unlink,
                        stdin=opts.stdin,
                        keep=parsed.keep,
                        force=parsed.force,
                        to_stdout=parsed.to_stdout,
                        test_only=parsed.test_only)
