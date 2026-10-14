from mirage.accessor.chroma import ChromaAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.core.chroma.tree import CHROMA_TREE
from mirage.core.slug_tree.stat import directory_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.path import parent


async def stat(
    accessor: ChromaAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    resolved = await CHROMA_TREE.resolve(accessor, path, index)
    if resolved.is_dir:
        return directory_stat(resolved)
    entry = resolved.entry
    if entry.size is None:
        # One scan for the whole directory, paid the first time anything in
        # it is stat'd; later stats of its siblings are already sized.
        await ensure_dir_sizes(accessor, parent(resolved.virtual_key), index)
        refreshed = await index.get(resolved.virtual_key)
        if refreshed.entry is not None:
            entry = refreshed.entry
    return FileStat(
        name=entry.name,
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=entry.size,
        modified=entry.extra.get("updated_at"),
        fingerprint=None,
        revision=None,
        extra=dict(entry.extra),
    )
