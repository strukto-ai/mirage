from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.read import read_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("read", resource="nextcloud")
async def read(accessor: NextcloudAccessor, path: PathSpec, *, index,
               **kwargs) -> bytes:
    return await read_bytes(accessor, path, index)
