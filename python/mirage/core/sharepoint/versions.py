from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive_ops import capture_item_metadata
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.types import PathSpec


async def capture_metadata(
        accessor: SharePointAccessor,
        path: PathSpec) -> tuple[str | None, str | None, str | None]:
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        return None, None, None
    virt = path.mount_path if isinstance(path, PathSpec) else path
    return await capture_item_metadata(accessor.config,
                                       drive_loc(resolved, virt))
