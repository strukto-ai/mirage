from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.create import create as create_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("create", resource="nextcloud", write=True)
async def create(accessor: NextcloudAccessor, path: PathSpec,
                 **kwargs) -> None:
    await create_impl(accessor, path)
