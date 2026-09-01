from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def create(accessor: NextcloudAccessor, path: PathSpec) -> None:
    key = path.mount_path.lstrip("/")
    timer = start_op()
    op = accessor.operator()
    await op.write(key, b"")
    record("create", path.virtual, "nextcloud", 0, timer)
    await invalidate_after_write(path)
