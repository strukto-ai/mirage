from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.nextcloud.stat import stat
from mirage.types import PathSpec


async def exists(accessor: NextcloudAccessor, path: PathSpec) -> bool:
    try:
        await stat(accessor, path, index=NULL_INDEX)
        return True
    except (FileNotFoundError, ValueError):
        return False
