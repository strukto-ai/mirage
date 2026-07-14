from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.sharepoint.stat import stat
from mirage.types import PathSpec


async def exists(accessor: SharePointAccessor,
                 path: PathSpec,
                 index: IndexCacheStore = NULL_INDEX) -> bool:
    try:
        await stat(accessor, path, index)
        return True
    except FileNotFoundError:
        return False
