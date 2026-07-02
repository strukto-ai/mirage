from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rmdir(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.mount_path
    key = raw.strip("/") + "/"
    op = accessor.operator()
    try:
        await op.delete(key)
    except NotFound as exc:
        raise enoent(path) from exc
    await invalidate_after_unlink(path)
