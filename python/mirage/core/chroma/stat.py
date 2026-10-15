from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.core.slug_tree.stat import tree_stat
from mirage.core.slug_tree.tree import tree_key
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import parent


async def _checked_row(
    accessor: ChromaAccessor, path: PathSpec, index: ListingCheckStore
) -> FileStat | None:
    """The row the collection's tree names at ``path`` now, None for none,
    kept with its folder's rows in the check's own store, where a page is
    sized.

    Args:
        accessor (ChromaAccessor): the mount's collection.
        path (PathSpec): a path below the root.
        index (ListingCheckStore): the check's store.
    """
    folder, _, name = tree_key(path).rpartition("/")
    rows = (await CHROMA_TREE.load(accessor)).get(folder or "/", [])
    await index.set_dir(
        parent(path.virtual.rstrip("/")), [(row.name, row) for row in rows]
    )
    return next((row for row in rows if row.name == name), None)


async def stat(
    accessor: ChromaAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    """Stat a path, sizing a page its listing left unsized. A fresh check
    is handed no row, so it reads the path's row from the tree.

    Args:
        accessor (ChromaAccessor): the mount's collection.
        path (PathSpec): the path.
        entry (FileStat | None): what is at the path.
        index (IndexCacheStore): the store the stat runs under.
    """
    if (
        entry is None
        and isinstance(index, ListingCheckStore)
        and path.mount_path.strip("/")
    ):
        entry = await _checked_row(accessor, path, index)
    row = tree_stat(path, entry)
    if row.type is not FileType.FILE or row.size is not None:
        return row
    # One scan for the whole directory, paid the first time anything in it
    # is stat'd; later stats of its siblings are already sized.
    key = path.virtual.rstrip("/")
    await ensure_dir_sizes(accessor, parent(key), index)
    sized = (await index.get(key)).entry
    return sized if isinstance(sized, FileStat) else row
