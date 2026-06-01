from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.stat import stat
from mirage.types import PathSpec


async def exists(accessor: NextcloudAccessor, path: PathSpec) -> bool:
    try:
        await stat(accessor, path)
        return True
    except (FileNotFoundError, ValueError):
        return False
