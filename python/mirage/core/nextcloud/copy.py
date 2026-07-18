from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def copy(accessor: NextcloudAccessor, src_spec: str | PathSpec,
               dst_spec: str | PathSpec) -> None:
    src = src_spec.mount_path if isinstance(src_spec, PathSpec) else src_spec
    dst = dst_spec.mount_path if isinstance(dst_spec, PathSpec) else dst_spec
    src_key = src.lstrip("/")
    dst_key = dst.lstrip("/")
    op = accessor.operator()
    try:
        await op.copy(src_key, dst_key)
    except NotFound as exc:
        raise enoent(src) from exc
    await invalidate_after_write(dst)
