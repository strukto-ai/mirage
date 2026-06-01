from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec


async def create(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    key = path.strip_prefix.lstrip("/")
    op = accessor.operator()
    await op.write(key, b"")
