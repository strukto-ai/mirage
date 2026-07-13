from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.nextcloud.constants import SCOPE_ERROR
from mirage.core.nextcloud.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import resolve_glob_with


async def resolve_glob(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore,
) -> list[PathSpec]:
    return await resolve_glob_with(readdir, accessor, paths, index,
                                   SCOPE_ERROR)
