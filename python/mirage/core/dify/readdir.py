from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify.path import resolve_path
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir


async def readdir(accessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    resolved = await resolve_path(accessor, path, index)
    if not resolved.is_dir:
        raise enotdir(path)
    listing = await index.list_dir(resolved.virtual_key)
    if listing.entries is None:
        raise enoent(path)
    return listing.entries
