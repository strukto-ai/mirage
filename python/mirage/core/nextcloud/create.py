from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec


async def create(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    key = path.mount_path.lstrip("/")
    op = accessor.operator()
    await op.write(key, b"")
    await invalidate_after_write(path)
