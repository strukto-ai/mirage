from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.fence import remove
from mirage.types import PathSpec


async def rm_r(accessor: NextcloudAccessor, path: PathSpec) -> None:
    """Remove a subtree in one DELETE that the server refuses once
    anything below has changed since the survey (:func:`remove`): what
    changed stays, and the call raises ENOTEMPTY.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the subtree's root.
    """
    await remove(accessor, path, empty=False)
