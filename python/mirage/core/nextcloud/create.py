from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.util import nextcloud_key
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def create(accessor: NextcloudAccessor, path: PathSpec) -> None:
    key = nextcloud_key(path)
    timer = start_op()
    op = accessor.operator()
    await op.write(key, b"")
    record("create", path.virtual, "nextcloud", 0, timer)
