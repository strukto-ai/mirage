from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.rm import remove
from mirage.types import PathSpec


async def rmdir(accessor: NextcloudAccessor, path: PathSpec) -> None:
    """Remove an empty collection, refusing one that holds a child or
    gains one before the DELETE lands (:func:`remove`).

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): collection to remove.
    """
    await remove(accessor, path, empty=True)
