from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.chroma.client import pages_chunks
from mirage.core.chroma.render import render_page


async def ensure_dir_sizes(
    accessor: ChromaAccessor,
    directory: str,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    """Fill in the exact size of every unsized file in one directory.

    The path tree's own ``size`` is producer-supplied and describes the
    source document, not the chunk join mirage serves, so it cannot be
    trusted as a byte length. This pays one scan per directory actually
    stat'd instead, and only for files still missing a size. A page with
    no chunks reads as nothing, so it is sized 0 and never scanned again.

    Args:
        accessor: chroma accessor.
        directory (str): virtual key of the directory to size.
        index (IndexCacheStore): index cache.
    """
    listing = await index.list_dir(directory)
    if listing.entries is None:
        return
    pending: dict[str, IndexEntry] = {}
    for child in listing.entries:
        lookup = await index.get(child)
        entry = lookup.entry
        if (
            entry is not None
            and entry.resource_type == "file"
            and entry.size is None
        ):
            pending[child] = entry
    if not pending:
        return
    grouped = await pages_chunks(
        accessor, [entry.extra["slug"] for entry in pending.values()]
    )
    for child, entry in pending.items():
        entry.size = len(render_page(grouped.get(entry.extra["slug"]) or []))
        await index.put(child, entry)
