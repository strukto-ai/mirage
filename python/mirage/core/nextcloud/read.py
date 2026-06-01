import time

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec


async def read_bytes(accessor: NextcloudAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = None,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        if offset or size is not None:
            async with await op.open(key, "rb") as f:
                if offset:
                    await f.seek(offset)
                data = await f.read(size
                                    ) if size is not None else await f.read()
        else:
            data = bytes(await op.read(key))
    except NotFound as exc:
        raise FileNotFoundError(raw) from exc
    record("read", raw, "nextcloud", len(data), start_ms)
    return data
