import errno
from collections.abc import AsyncIterator

from mirage.cache.index import IndexCacheStore
from mirage.core.dify._client import get_document_segments, iter_segment_pages
from mirage.core.dify.path import resolve_path
from mirage.types import PathSpec


async def read_bytes(accessor, path: PathSpec,
                     index: IndexCacheStore) -> bytes:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    segments = await get_document_segments(accessor.config, resolved.entry.id)
    return segments_to_bytes(segments)


async def read_stream(accessor, path: PathSpec,
                      index: IndexCacheStore) -> AsyncIterator[bytes]:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        raise IsADirectoryError(errno.EISDIR, "Is a directory", path.virtual)
    first = True
    async for page in iter_segment_pages(accessor.config, resolved.entry.id):
        for segment in page:
            if first:
                first = False
            else:
                yield b"\n"
            yield segment_text(segment).encode()


def segments_to_bytes(segments: list[dict]) -> bytes:
    return "\n".join(segment_text(segment) for segment in segments).encode()


def segment_text(segment: dict) -> str:
    value = segment.get("content")
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)
