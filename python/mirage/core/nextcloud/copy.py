from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec


async def copy(accessor: NextcloudAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    if isinstance(src, str):
        src = PathSpec.from_str_path(src)
    if isinstance(dst, str):
        dst = PathSpec.from_str_path(dst)
    src_key = src.strip_prefix.lstrip("/")
    dst_key = dst.strip_prefix.lstrip("/")
    op = accessor.operator()
    try:
        await op.copy(src_key, dst_key)
    except NotFound as exc:
        raise FileNotFoundError(src.strip_prefix) from exc
