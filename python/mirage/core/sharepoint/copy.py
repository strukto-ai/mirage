from functools import partial

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive_ops import DriveLoc, copy_tree
from mirage.core.sharepoint._client import drive_ref_path, item_url
from mirage.core.sharepoint._resolver import ResolvedPath, resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def drive_loc(resolved: ResolvedPath, virt: str) -> DriveLoc:
    assert resolved.drive_id is not None
    assert resolved.item_path is not None
    return DriveLoc(drive=resolved.drive_id,
                    path=resolved.item_path,
                    virt=virt,
                    url=partial(item_url, resolved.drive_id),
                    ref=partial(drive_ref_path, resolved.drive_id))


async def copy(accessor: SharePointAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    src_resolved = await resolve(accessor, src)
    dst_resolved = await resolve(accessor, dst)
    if (src_resolved.drive_id is None or src_resolved.item_path is None
            or dst_resolved.drive_id is None
            or dst_resolved.item_path is None):
        raise enoent(src.virtual if isinstance(src, PathSpec) else src)
    dst_virt = dst.mount_path if isinstance(dst, PathSpec) else dst
    src_virt = src.mount_path if isinstance(src, PathSpec) else src
    await copy_tree(accessor.config, drive_loc(src_resolved, src_virt),
                    drive_loc(dst_resolved, dst_virt))
