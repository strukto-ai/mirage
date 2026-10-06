from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enotsup
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def truncate(
    accessor: NextcloudAccessor,
    path: PathSpec,
    length: int,
    no_create: bool = False,
) -> None:
    if no_create:
        raise enotsup("nextcloud", "truncate --no-create", path)
    key = nextcloud_key(path)
    timer = start_op()
    op = accessor.operator()
    try:
        data = bytes(await op.read(key))
    except NotFound:
        data = b""
    result = data[:length].ljust(length, b"\0")
    await op.write(key, result)
    record("truncate", path.virtual, "nextcloud", 0, timer)
    await invalidate_after_write(path)
