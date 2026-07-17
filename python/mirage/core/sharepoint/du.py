from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX
from mirage.core.msgraph.drive_ops import du_tree_entries, du_tree_total
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: SharePointAccessor, path: PathSpec) -> int:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return 0
    virt = path.mount_path if isinstance(path, PathSpec) else path
    return await du_tree_total(accessor.config, drive_loc(resolved, virt))


async def du_all(accessor: SharePointAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    try:
        info = await stat(accessor, path, index=NULL_INDEX)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return []
    virt = path.mount_path if isinstance(path, PathSpec) else path
    return await du_tree_entries(accessor.config, drive_loc(resolved, virt))
