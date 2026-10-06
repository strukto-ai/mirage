from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def read(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    key = nextcloud_key(path)
    op = accessor.operator()
    timer = start_op()
    try:
        if offset or size is not None:
            async with await op.open(key, "rb") as f:
                if offset:
                    await f.seek(offset)
                data = (
                    await f.read(size) if size is not None else await f.read()
                )
        else:
            data = bytes(await op.read(key))
    except NotFound as exc:
        raise enoent(path) from exc
    record("read", path.virtual, "nextcloud", len(data), timer)
    return data
