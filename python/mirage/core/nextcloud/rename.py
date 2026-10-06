from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_subtree
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def rename(
    accessor: NextcloudAccessor, src: PathSpec, dst: PathSpec
) -> None:
    src_key = nextcloud_key(src)
    dst_key = nextcloud_key(dst)
    op = accessor.operator()
    try:
        await op.rename(src_key, dst_key)
    except NotFound as exc:
        raise enoent(src) from exc
    await invalidate_subtree(dst)
    await invalidate_subtree(src)
