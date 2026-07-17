import posixpath

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint._client import (GraphError, drive_ref_path,
                                            graph_delete, graph_get,
                                            graph_list, graph_post_monitor,
                                            item_url, poll_monitor)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _copy_once(config: SharePointConfig, src_drive: str, src_path: str,
                     dst_drive: str, dst_path: str) -> tuple[str, str] | None:
    """One Graph copy attempt, surfacing a conflict instead of raising.

    Graph copies default to ``fail`` on a name conflict and the
    ``@microsoft.graph.conflictBehavior=replace`` query parameter is
    files-only, so the caller resolves conflicts itself
    (delete-and-retry for files, per-child merge for folders).

    Args:
        config (SharePointConfig): SharePoint config.
        src_drive (str): source drive id.
        src_path (str): drive-relative source path.
        dst_drive (str): destination drive id.
        dst_path (str): drive-relative destination path.

    Returns:
        tuple[str, str] | None: ``(code, message)`` of a failed copy, or
        None when the copy completed.
    """
    dst_parent = posixpath.dirname("/" + dst_path).strip("/")
    body: dict = {"name": posixpath.basename(dst_path)}
    if src_drive == dst_drive:
        body["parentReference"] = {
            "path": drive_ref_path(dst_drive, dst_parent)
        }
    else:
        body["parentReference"] = {
            "driveId": dst_drive,
            "path": drive_ref_path(dst_drive, dst_parent),
        }
    url = item_url(src_drive, src_path, action="/copy")
    try:
        monitor = await graph_post_monitor(config, url, body)
    except GraphError as exc:
        if exc.status == 409 or exc.code == "nameAlreadyExists":
            return exc.code, str(exc)
        raise
    if not monitor:
        return None
    result = await poll_monitor(monitor, timeout=config.timeout)
    status = result.get("status")
    if status == "failed":
        err = result.get("error", {}) if isinstance(result, dict) else {}
        return (err.get("code", "copyFailed"), err.get("message",
                                                       "copy failed"))
    if status not in ("completed", None):
        raise GraphError(504, "copyTimeout", "copy not confirmed complete")
    return None


async def _copy_tree(config: SharePointConfig, src_drive: str, src_path: str,
                     dst_drive: str, dst_path: str, dst_virt: str) -> None:
    err = await _copy_once(config, src_drive, src_path, dst_drive, dst_path)
    if err is None:
        await invalidate_after_write(dst_virt)
        return
    code, message = err
    if code != "nameAlreadyExists":
        raise GraphError(500, code, message)
    src_item = await graph_get(config, item_url(src_drive, src_path))
    dst_item = await graph_get(config, item_url(dst_drive, dst_path))
    if "folder" in src_item and "folder" in dst_item:
        # GNU cp -r merges into an existing directory; Graph never merges
        # folders, so recurse per child instead.
        children = await graph_list(
            config, item_url(src_drive, src_path, action="/children"))
        for child in children:
            name = child.get("name", "")
            await _copy_tree(config, src_drive, f"{src_path}/{name}",
                             dst_drive, f"{dst_path}/{name}",
                             f"{dst_virt}/{name}")
        return
    if "folder" in src_item or "folder" in dst_item:
        raise GraphError(409, code, message)
    await graph_delete(config, item_url(dst_drive, dst_path))
    err = await _copy_once(config, src_drive, src_path, dst_drive, dst_path)
    if err is not None:
        raise GraphError(500, err[0], err[1])
    await invalidate_after_write(dst_virt)


async def copy(accessor: SharePointAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    src_resolved = await resolve(accessor, src)
    dst_resolved = await resolve(accessor, dst)
    if (src_resolved.drive_id is None or src_resolved.item_path is None
            or dst_resolved.drive_id is None
            or dst_resolved.item_path is None):
        raise enoent(src.virtual if isinstance(src, PathSpec) else src)
    dst_virt = dst.mount_path if isinstance(dst, PathSpec) else dst
    await _copy_tree(accessor.config, src_resolved.drive_id,
                     src_resolved.item_path, dst_resolved.drive_id,
                     dst_resolved.item_path, dst_virt)
