from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.rmdir import rmdir as rmdir_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("rmdir", resource="nextcloud", write=True)
async def rmdir(accessor: NextcloudAccessor, path: PathSpec, **kwargs) -> None:
    await rmdir_impl(accessor, path)
