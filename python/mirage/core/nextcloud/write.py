from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.util import nextcloud_key
from mirage.errors.fs import enoent
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def write(
    accessor: NextcloudAccessor,
    path: PathSpec,
    data: bytes,
) -> None:
    key = nextcloud_key(path)
    op = accessor.operator()
    timer = start_op()
    try:
        await op.write(key, data)
    except NotFound as exc:
        raise enoent(path) from exc
    record("write", path.virtual, "nextcloud", len(data), timer)
