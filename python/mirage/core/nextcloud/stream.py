from collections.abc import AsyncIterator

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.nextcloud.constants import DEFAULT_CHUNK_SIZE
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_stream(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    rec = record_stream("read", raw, "nextcloud")
    try:
        async with await op.open(key, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                chunk_bytes = bytes(chunk)
                if rec is not None:
                    rec.bytes += len(chunk_bytes)
                yield chunk_bytes
    except NotFound as exc:
        raise enoent(path) from exc
