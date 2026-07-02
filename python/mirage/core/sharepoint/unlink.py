from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.core.sharepoint._client import (GraphError, graph_delete, item_url,
                                            split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: SharePointAccessor, path: PathSpec) -> None:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    try:
        await graph_delete(accessor.config,
                           item_url(resolved.drive_id, resolved.item_path))
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    await invalidate_after_unlink(path)
