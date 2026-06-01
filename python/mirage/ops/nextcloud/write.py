from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.write import write_bytes
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("write", resource="nextcloud", write=True)
async def write(accessor: NextcloudAccessor, path: PathSpec, data: bytes,
                **kwargs) -> None:
    await write_bytes(accessor, path, data)
