from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import drive_root_empty
from mirage.core.sharepoint.client import graph_delete, item_url, split_path
from mirage.core.sharepoint.resolve import drive_loc, resolve
from mirage.types import PathSpec
from mirage.utils.errors import enotempty


async def rmdir(accessor: SharePointAccessor,
                path: PathSpec,
                index: IndexCacheStore = NULL_INDEX) -> None:
    """Remove an empty folder.

    A Graph ``DELETE /drives/{id}/items/{item}`` removes a folder and
    everything under it, so this is the same request ``rm_r`` sends and
    the emptiness check is the only thing separating them. Without it
    ``rmdir`` destroyed the whole subtree for every caller that does not
    pre-check emptiness itself, and the command builders are the only
    callers that do: FUSE, ``ws.fs`` and the sandbox runtimes all reach
    the op directly.

    Args:
        accessor (SharePointAccessor): SharePoint accessor.
        path (PathSpec): folder to remove.
        index (IndexCacheStore): accepted for the rmdir slot's shape;
            unused.
    """
    _, stripped = split_path(path)
    if not stripped:
        return
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        return
    loc = drive_loc(accessor.config, resolved, path.virtual)
    if not await drive_root_empty(accessor.config, loc, session=accessor.pool):
        raise enotempty(path)
    await graph_delete(accessor.config,
                       item_url(accessor.config, resolved.drive_id,
                                resolved.item_path),
                       session=accessor.pool)
    await invalidate_after_unlink(path)
