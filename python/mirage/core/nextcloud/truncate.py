from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def truncate(accessor: NextcloudAccessor, path: PathSpec,
                   length: int) -> None:
    key = path.mount_path.lstrip("/")
    timer = start_op()
    op = accessor.operator()
    try:
        data = bytes(await op.read(key))
    except NotFound:
        data = b""
    result = data[:length].ljust(length, b"\0")
    await op.write(key, result)
    record("truncate", path.virtual, "nextcloud", 0, timer)
    await invalidate_after_write(path)
