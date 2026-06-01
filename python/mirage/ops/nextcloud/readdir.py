from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.readdir import readdir as readdir_impl
from mirage.ops.registry import op
from mirage.types import PathSpec


@op("readdir", resource="nextcloud")
async def readdir(accessor: NextcloudAccessor, path: PathSpec, *, index,
                  **kwargs) -> list[str]:
    return await readdir_impl(accessor, path, index)
