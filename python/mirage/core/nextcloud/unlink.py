from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: NextcloudAccessor, path: PathSpec) -> None:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    timer = start_op()
    try:
        await op.delete(key)
    except NotFound as exc:
        raise enoent(path) from exc
    record("unlink", path.virtual, "nextcloud", 0, timer)
    await invalidate_after_unlink(path)
