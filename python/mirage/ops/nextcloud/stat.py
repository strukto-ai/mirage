from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.stat import stat as stat_impl
from mirage.ops.registry import op
from mirage.types import FileStat, PathSpec


@op("stat", resource="nextcloud")
async def stat(accessor: NextcloudAccessor, path: PathSpec, *, index,
               **kwargs) -> FileStat:
    return await stat_impl(accessor, path, index)
