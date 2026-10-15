from mirage.accessor.wandb import WandbAccessor
from mirage.core.wandb.pathing import parts
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec


async def stat(
    accessor: WandbAccessor, path: PathSpec, entry: FileStat | None = None
) -> FileStat:
    """A path's stat: the row its parent's listing names.

    Args:
        accessor (WandbAccessor): the mount's accessor.
        path (PathSpec): the path.
        entry (FileStat | None): the row the parent's listing holds.
    """
    if not parts(accessor, path):
        return FileStat(name="/", type=FileType.DIRECTORY, size=0)
    if entry is None:
        raise enoent(path)
    return entry
