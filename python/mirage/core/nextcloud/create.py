import time

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.observe.context import record
from mirage.types import PathSpec


async def create(accessor: NextcloudAccessor, path: PathSpec) -> None:
    key = path.mount_path.lstrip("/")
    start_ms = int(time.monotonic() * 1000)
    op = accessor.operator()
    await op.write(key, b"")
    record("create", path.virtual, "nextcloud", 0, start_ms)
    await invalidate_after_write(path)
