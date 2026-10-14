from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.tree import DIFY_TREE
from mirage.core.slug_tree.stat import directory_stat
from mirage.types import ContentType, FileStat, FileType, PathSpec


async def stat(
    accessor: DifyAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> FileStat:
    resolved = await DIFY_TREE.resolve(accessor, path, index)
    if resolved.is_dir:
        return directory_stat(resolved)
    return FileStat(
        name=resolved.entry.name,
        type=FileType.FILE,
        content=ContentType.TEXT,
        size=None,
        modified=resolved.entry.remote_time or None,
        birthtime=resolved.entry.remote_time or None,
        fingerprint=None,
        revision=None,
        extra={**resolved.entry.extra, "document_id": resolved.entry.id},
    )
