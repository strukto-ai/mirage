from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.truncate import truncate as truncate_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("truncate", resource="nextcloud", write=True)
async def truncate(accessor: NextcloudAccessor, path: PathSpec, length: int,
                   **kwargs) -> None:
    await truncate_impl(accessor, path, length)
