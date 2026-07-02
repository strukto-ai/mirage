import errno
from collections.abc import AsyncIterator

from mirage.cache.index import IndexCacheStore
from mirage.core.chroma._client import fetch_page_chunks, iter_page_chunks
from mirage.core.chroma.path import resolve_path
from mirage.types import PathSpec


async def read_bytes(accessor, path: PathSpec,
                     index: IndexCacheStore) -> bytes:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    text = await fetch_page_chunks(accessor, resolved.entry.extra["slug"])
    return text.encode()


async def read_stream(accessor, path: PathSpec,
                      index: IndexCacheStore) -> AsyncIterator[bytes]:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    first = True
    async for chunk in iter_page_chunks(accessor,
                                        resolved.entry.extra["slug"]):
        if first:
            first = False
        else:
            yield b"\n"
        yield chunk.encode()
