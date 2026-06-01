from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec


async def mkdir(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    key = path.strip_prefix.strip("/") + "/"
    op = accessor.operator()
    await op.create_dir(key)
