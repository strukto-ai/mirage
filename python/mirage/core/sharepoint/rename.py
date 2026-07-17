from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.msgraph.drive_ops import rename_replace
from mirage.core.sharepoint._resolver import resolve
from mirage.core.sharepoint.copy import drive_loc
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
    src_virt = src.mount_path if isinstance(src, PathSpec) else src
    dst_virt = dst.mount_path if isinstance(dst, PathSpec) else dst
    await rename_replace(accessor.config, drive_loc(src_resolved, src_virt),
                         drive_loc(dst_resolved, dst_virt))
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
