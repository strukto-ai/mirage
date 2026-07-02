import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.sharepoint._client import (drive_ref_path, graph_patch,
                                            item_url)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(accessor: SharePointAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    src_resolved = await resolve(accessor, src)
    dst_resolved = await resolve(accessor, dst)
    if (src_resolved.drive_id is None or src_resolved.item_path is None
            or dst_resolved.drive_id is None
            or dst_resolved.item_path is None):
        raise enoent(src.virtual if isinstance(src, PathSpec) else src)
    src_parent = posixpath.dirname("/" + src_resolved.item_path).strip("/")
    dst_parent = posixpath.dirname("/" + dst_resolved.item_path).strip("/")
    name = posixpath.basename(dst_resolved.item_path)
    body: dict = {"name": name}
    if (dst_parent != src_parent
            or src_resolved.drive_id != dst_resolved.drive_id):
        body["parentReference"] = {
            "path": drive_ref_path(dst_resolved.drive_id, dst_parent)
        }
    await graph_patch(accessor.config,
                      item_url(src_resolved.drive_id, src_resolved.item_path),
                      body)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
