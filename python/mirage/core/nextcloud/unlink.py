import time

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        await op.delete(key)
    except NotFound as exc:
        raise enoent(path) from exc
    record("unlink", path.virtual, "nextcloud", 0, start_ms)
    await invalidate_after_unlink(path)
