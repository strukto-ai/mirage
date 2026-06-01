from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.unlink import unlink as unlink_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("unlink", resource="nextcloud", write=True)
async def unlink(accessor: NextcloudAccessor, path: PathSpec,
                 **kwargs) -> None:
    await unlink_impl(accessor, path)
