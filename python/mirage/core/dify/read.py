from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.client import get_document_segments, iter_segment_pages
from mirage.core.dify.tree import DIFY_TREE
from mirage.core.slug_tree.read import file_entry, join_lines
from mirage.types import PathSpec
from mirage.utils.ranges import slice_window


async def read(
    accessor: DifyAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a document, optionally only a byte range of it.

    A document is rendered here from its segments, so its bytes do not
    exist until we make them and the window can only be taken
    afterwards, the same way the rendered branches of gdrive, slack and
    discord take theirs.

    Args:
        accessor (DifyAccessor): Dify accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): listing cache, consulted for the entry.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    entry = await file_entry(DIFY_TREE, accessor, path, index)
    segments = await get_document_segments(accessor, entry.id)
    rendered = "\n".join(segment_text(segment) for segment in segments)
    return slice_window(rendered.encode(), offset, size)


async def read_stream(
    accessor: DifyAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> AsyncIterator[bytes]:
    entry = await file_entry(DIFY_TREE, accessor, path, index)
    async for chunk in join_lines(segment_texts(accessor, entry.id)):
        yield chunk


async def segment_texts(
    accessor: DifyAccessor, document_id: str
) -> AsyncIterator[str]:
    async for page in iter_segment_pages(accessor, document_id):
        for segment in page:
            yield segment_text(segment)


def segment_text(segment: dict[str, Any]) -> str:
    value = segment.get("content")
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(value)
