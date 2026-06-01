from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.rename import rename as rename_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("rename", resource="nextcloud", write=True)
async def rename(accessor: NextcloudAccessor, src: PathSpec, dst: PathSpec,
                 **kwargs) -> None:
    await rename_impl(accessor, src, dst)
