import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint._client import graph_post, item_url, split_path
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _create_dir(accessor: SharePointAccessor, drive_id: str,
                      stripped: str) -> None:
    parent = posixpath.dirname("/" + stripped).strip("/")
    name = posixpath.basename(stripped)
    url = item_url(drive_id,
                   "/" + parent if parent else "/",
                   action="/children")
    body = {
        "name": name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "replace",
    }
    await graph_post(accessor.config, url, body)


async def mkdir(accessor: SharePointAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    virtual = path.original if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    if not stripped:
        return
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    drive_id = resolved.drive_id
    item_p = resolved.item_path
    if parents:
        parts = item_p.split("/")
        for i in range(len(parts)):
            await _create_dir(accessor, drive_id, "/".join(parts[:i + 1]))
    else:
        await _create_dir(accessor, drive_id, item_p)
    await invalidate_after_write(path)
