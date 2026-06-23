import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint._client import (GraphError, drive_ref_path,
                                            graph_post_monitor, item_url,
                                            poll_monitor)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def copy(accessor: SharePointAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    src_resolved = await resolve(accessor, src)
    dst_resolved = await resolve(accessor, dst)
    if (src_resolved.drive_id is None or src_resolved.item_path is None
            or dst_resolved.drive_id is None
            or dst_resolved.item_path is None):
        raise enoent(src.original if isinstance(src, PathSpec) else src)
    dst_parent = posixpath.dirname("/" + dst_resolved.item_path).strip("/")
    name = posixpath.basename(dst_resolved.item_path)
    url = item_url(src_resolved.drive_id,
                   src_resolved.item_path,
                   action="/copy")
    body: dict = {"name": name}
    if src_resolved.drive_id == dst_resolved.drive_id:
        body["parentReference"] = {
            "path": drive_ref_path(dst_resolved.drive_id, dst_parent)
        }
    else:
        body["parentReference"] = {
            "driveId": dst_resolved.drive_id,
            "path": drive_ref_path(dst_resolved.drive_id, dst_parent),
        }
    monitor = await graph_post_monitor(accessor.config, url, body)
    if not monitor:
        return
    result = await poll_monitor(monitor, timeout=accessor.config.timeout)
    status = result.get("status")
    if status == "failed":
        err = result.get("error", {}) if isinstance(result, dict) else {}
        raise GraphError(500, err.get("code", "copyFailed"),
                         err.get("message", "copy failed"))
    if status not in ("completed", None):
        raise GraphError(504, "copyTimeout", "copy not confirmed complete")
    await invalidate_after_write(dst)
