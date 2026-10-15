from collections.abc import AsyncIterator

from mirage.accessor.chroma import ChromaAccessor
from mirage.core.chroma.client import iter_page_chunks, page_chunks
from mirage.core.chroma.render import render_page
from mirage.core.slug_tree.read import file_entry, join_lines
from mirage.types import FileStat, PathSpec


async def read(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> bytes:
    found = file_entry(path, entry)
    return render_page(await page_chunks(accessor, found.extra["slug"]))


async def read_stream(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> AsyncIterator[bytes]:
    found = file_entry(path, entry)
    async for chunk in join_lines(
        iter_page_chunks(accessor, found.extra["slug"])
    ):
        yield chunk
