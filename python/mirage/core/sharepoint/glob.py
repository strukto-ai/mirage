from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.constants import SCOPE_ERROR
from mirage.core.sharepoint.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import resolve_glob_with


async def resolve_glob(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    index: IndexCacheStore = NULL_INDEX,
) -> list[PathSpec]:
    return await resolve_glob_with(readdir, accessor, paths, index,
                                   SCOPE_ERROR)
