from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.path import resolve_path
from mirage.core.chroma.sizes import ensure_dir_sizes
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import parent


async def stat_light(accessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> FileStat:
    # Never triggers the directory size scan: callers that only need the
    # type must not pay for byte lengths.
    return await stat(accessor, path, index, sizes=False)


async def stat(accessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX,
               sizes: bool = True) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    entry = resolved.entry
    if sizes and entry.size is None:
        # One scan for the whole directory, paid the first time anything in
        # it is stat'd; later stats of its siblings are already sized.
        await ensure_dir_sizes(accessor, parent(resolved.virtual_key), index)
        refreshed = await index.get(resolved.virtual_key)
        if refreshed.entry is not None:
            entry = refreshed.entry
    return FileStat(
        name=entry.name,
        type=FileType.TEXT,
        size=entry.size,
        modified=entry.extra.get("updated_at"),
        fingerprint=None,
        revision=None,
        extra=dict(entry.extra),
    )


def stat_name(virtual_key: str, mount_prefix: str) -> str:
    root = mount_prefix.rstrip("/") or "/"
    if virtual_key == root:
        return "/"
    return virtual_key.rstrip("/").rsplit("/", 1)[-1]
