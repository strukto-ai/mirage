from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import settle_after_write, write_generation
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.nextcloud.util import nextcloud_key
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def write_bytes(
    accessor: NextcloudAccessor,
    path: PathSpec,
    data: bytes,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    key = nextcloud_key(path)
    op = accessor.operator()
    timer = start_op()
    generation = write_generation()
    try:
        await op.write(key, data)
    except NotFound as exc:
        raise enoent(path) from exc
    record("write", path.virtual, "nextcloud", len(data), timer)
    await settle_after_write(path, data, None, generation)
