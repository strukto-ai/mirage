import time

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.observe.context import record
from mirage.types import PathSpec


async def unlink(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        await op.delete(key)
    except NotFound as exc:
        raise FileNotFoundError(raw) from exc
    record("unlink", path.original, "nextcloud", 0, start_ms)
