from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec


async def mkdir(accessor: NextcloudAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    # opendal create_dir creates missing parents; parents is implicit.
    key = path.mount_path.strip("/") + "/"
    op = accessor.operator()
    await op.create_dir(key)
    await invalidate_after_write(path)
