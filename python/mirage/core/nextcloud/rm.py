from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_subtree
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def rm_r(accessor: NextcloudAccessor, path: PathSpec) -> None:
    key = nextcloud_key(path).rstrip("/") + "/"
    op = accessor.operator()
    try:
        await op.remove_all(key)
    except NotFound as exc:
        raise enoent(path) from exc
    await invalidate_subtree(path)
