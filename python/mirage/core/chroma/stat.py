from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.chroma.path import resolve_path
from mirage.types import FileStat, FileType, PathSpec


async def stat_light(accessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> FileStat:
    return await stat(accessor, path, index)


async def stat(accessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    return FileStat(
        name=resolved.entry.name,
        type=FileType.TEXT,
        size=resolved.entry.size,
        modified=resolved.entry.extra.get("updated_at"),
        fingerprint=None,
        revision=None,
        extra=dict(resolved.entry.extra),
    )


def stat_name(virtual_key: str, mount_prefix: str) -> str:
    root = mount_prefix.rstrip("/") or "/"
    if virtual_key == root:
        return "/"
    return virtual_key.rstrip("/").rsplit("/", 1)[-1]
