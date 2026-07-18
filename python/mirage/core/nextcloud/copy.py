from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def copy(accessor: NextcloudAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    src_key = src.mount_path.lstrip("/")
    dst_key = dst.mount_path.lstrip("/")
    op = accessor.operator()
    try:
        await op.copy(src_key, dst_key)
    except NotFound as exc:
        raise enoent(src) from exc
    await invalidate_after_write(dst)
