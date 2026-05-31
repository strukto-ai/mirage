from mirage.cache.index import IndexCacheStore
from mirage.core.dify.path import resolve_path
from mirage.types import PathSpec


async def readdir(accessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    resolved = await resolve_path(accessor, path, index)
    if not resolved.is_dir:
        raise NotADirectoryError(path.original)
    listing = await index.list_dir(resolved.virtual_key)
    if listing.entries is None:
        raise FileNotFoundError(path.original)
    return listing.entries
