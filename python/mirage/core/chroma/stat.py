from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.core.slug_tree.stat import tree_stat
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import parent


async def stat(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat a path, sizing a page its listing left unsized.

    Args:
        accessor (ChromaAccessor): the mount's collection.
        path (PathSpec): the path.
        entry (FileStat | None): what is at the path.
        index (IndexCacheStore): the store the stat runs under.
    """
    row = tree_stat(path, entry)
    if row.type is not FileType.FILE or row.size is not None:
        return row
    # One scan for the whole directory, paid the first time anything in it
    # is stat'd; later stats of its siblings are already sized.
    key = path.virtual.rstrip("/")
    await ensure_dir_sizes(accessor, parent(key), index)
    sized = (await index.get(key)).entry
    return sized if isinstance(sized, FileStat) else row
