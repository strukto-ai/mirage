from collections.abc import AsyncIterator

from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.client import iter_page_chunks, page_chunks
from mirage.core.chroma.render import render_page
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.core.slug_tree.read import file_entry, join_lines
from mirage.types import PathSpec


async def read(
    accessor: ChromaAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    entry = await file_entry(CHROMA_TREE, accessor, path, index)
    return render_page(await page_chunks(accessor, entry.extra["slug"]))


async def read_stream(
    accessor: ChromaAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    entry = await file_entry(CHROMA_TREE, accessor, path, index)
    async for chunk in join_lines(
        iter_page_chunks(accessor, entry.extra["slug"])
    ):
        yield chunk
