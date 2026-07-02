from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(accessor: NextcloudAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    if isinstance(src, str):
        src = PathSpec.from_str_path(src)
    if isinstance(dst, str):
        dst = PathSpec.from_str_path(dst)
    src_key = src.mount_path.lstrip("/")
    dst_key = dst.mount_path.lstrip("/")
    op = accessor.operator()
    try:
        await op.rename(src_key, dst_key)
    except NotFound as exc:
        raise enoent(src) from exc
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
