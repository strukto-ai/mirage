from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import stat_item
from mirage.core.sharepoint._client import split_path
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


async def stat(accessor: SharePointAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)

    resolved = await resolve(accessor, path)

    if resolved.level == "site":
        if resolved.site_id is None:
            raise enoent(virtual)
        return FileStat(name=stripped, type=FileType.DIRECTORY)

    if resolved.level == "drive":
        if resolved.drive_id is None:
            raise enoent(virtual)
        return FileStat(name=stripped.rsplit("/", 1)[-1],
                        type=FileType.DIRECTORY)

    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)

    virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped)
    return await stat_item(accessor.config, drive_loc(resolved, stripped),
                           virtual, virtual_key, index)
