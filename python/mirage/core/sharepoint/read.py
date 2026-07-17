from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import read_item
from mirage.core.sharepoint._client import split_path
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(accessor: SharePointAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    return await read_item(accessor.config,
                           drive_loc(resolved, stripped),
                           virtual,
                           stripped,
                           "sharepoint",
                           offset=offset,
                           size=size)
