import time

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def write_bytes(accessor: NextcloudAccessor,
                      path: PathSpec,
                      data: bytes,
                      index: IndexCacheStore = NULL_INDEX) -> None:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        await op.write(key, data)
    except NotFound as exc:
        raise enoent(path) from exc
    record("write", path.virtual, "nextcloud", len(data), start_ms)
    await invalidate_after_write(path)
