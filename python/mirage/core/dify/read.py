from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.core.dify.client import get_document_segments, iter_segment_pages
from mirage.core.slug_tree.read import file_entry, join_lines
from mirage.types import FileStat, PathSpec
from mirage.utils.ranges import slice_window


async def read(
    accessor: DifyAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    entry: FileStat | None = None,
) -> bytes:
    """Read a document, optionally only a byte range of it.

    A document is rendered here from its segments, so its bytes do not
    exist until we make them and the window can only be taken
    afterwards, the same way the rendered branches of gdrive, slack and
    discord take theirs.

    Args:
        accessor (DifyAccessor): Dify accessor.
        path (PathSpec): the path to read.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
        entry (FileStat | None): what is at the path.
    """
    found = file_entry(path, entry)
    segments = await get_document_segments(
        accessor, str(found.extra["document_id"])
    )
    rendered = "\n".join(segment_text(segment) for segment in segments)
    return slice_window(rendered.encode(), offset, size)


async def read_stream(
    accessor: DifyAccessor, path: PathSpec, entry: FileStat | None = None
) -> AsyncIterator[bytes]:
    found = file_entry(path, entry)
    document_id = str(found.extra["document_id"])
    async for chunk in join_lines(segment_texts(accessor, document_id)):
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
