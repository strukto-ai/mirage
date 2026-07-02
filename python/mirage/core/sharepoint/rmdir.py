from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.sharepoint._client import graph_delete, item_url, split_path
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec


async def rmdir(accessor: SharePointAccessor, path: PathSpec) -> None:
    path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    if not stripped:
        return
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        return
    await graph_delete(accessor.config,
                       item_url(resolved.drive_id, resolved.item_path))
    await invalidate_after_unlink(path)
