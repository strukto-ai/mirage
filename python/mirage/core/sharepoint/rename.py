import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.sharepoint._client import (GraphError, drive_ref_path,
                                            graph_delete, graph_get,
                                            graph_list, graph_patch, item_url)
from mirage.core.sharepoint._resolver import ResolvedPath, resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _move_body(src_resolved: ResolvedPath, dst_resolved: ResolvedPath) -> dict:
    assert src_resolved.item_path is not None
    assert dst_resolved.item_path is not None
    assert dst_resolved.drive_id is not None
    src_parent = posixpath.dirname("/" + src_resolved.item_path).strip("/")
    dst_parent = posixpath.dirname("/" + dst_resolved.item_path).strip("/")
    body: dict = {"name": posixpath.basename(dst_resolved.item_path)}
    if (dst_parent != src_parent
            or src_resolved.drive_id != dst_resolved.drive_id):
        body["parentReference"] = {
            "path": drive_ref_path(dst_resolved.drive_id, dst_parent)
        }
    return body


async def rename(accessor: SharePointAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    src_resolved = await resolve(accessor, src)
    dst_resolved = await resolve(accessor, dst)
    if (src_resolved.drive_id is None or src_resolved.item_path is None
            or dst_resolved.drive_id is None
            or dst_resolved.item_path is None):
        raise enoent(src.virtual if isinstance(src, PathSpec) else src)
    config = accessor.config
    body = _move_body(src_resolved, dst_resolved)
    src_url = item_url(src_resolved.drive_id, src_resolved.item_path)
    dst_url = item_url(dst_resolved.drive_id, dst_resolved.item_path)
    try:
        await graph_patch(config, src_url, body)
    except GraphError as exc:
        if exc.status != 409 and exc.code != "nameAlreadyExists":
            raise
        # GNU mv overwrites the destination, but a Graph move has no
        # conflictBehavior that works across account types: drop the
        # conflicting file (or empty folder) and retry. A non-empty
        # folder conflict keeps the original error, mirroring mv's
        # "Directory not empty".
        dst_item = await graph_get(config, dst_url)
        if "folder" in dst_item:
            children = await graph_list(
                config,
                item_url(dst_resolved.drive_id,
                         dst_resolved.item_path,
                         action="/children"))
            if children:
                raise
        await graph_delete(config, dst_url)
        await graph_patch(config, src_url, body)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
