from collections.abc import AsyncIterator

from mirage.accessor.chroma import ChromaAccessor
from mirage.core.chroma.client import iter_page_chunks, page_chunks
from mirage.core.chroma.render import render_page
from mirage.core.hierarchy.probe import file_entry
from mirage.core.slug_tree.read import join_lines
from mirage.core.slug_tree.rows import scalar_string
from mirage.errors.fs import eisdir
from mirage.types import FileStat, PathSpec


def page_slug(path: PathSpec, entry: FileStat | None) -> str:
    slug = scalar_string(file_entry(path, entry).extra.get("slug"))
    if slug is None:
        raise eisdir(path.virtual)
    return slug


async def read(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> bytes:
    return render_page(await page_chunks(accessor, page_slug(path, entry)))


async def read_stream(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> AsyncIterator[bytes]:
    async for chunk in join_lines(
        iter_page_chunks(accessor, page_slug(path, entry))
    ):
        yield chunk
