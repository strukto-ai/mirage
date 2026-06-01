import time

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec


async def write_bytes(accessor: NextcloudAccessor,
                      path: PathSpec,
                      data: bytes,
                      index: IndexCacheStore = None) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        await op.write(key, data)
    except NotFound as exc:
        raise FileNotFoundError(raw) from exc
    record("write", path.original, "nextcloud", len(data), start_ms)
