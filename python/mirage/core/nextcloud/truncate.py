from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec


async def truncate(accessor: NextcloudAccessor, path: PathSpec,
                   length: int) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    key = path.strip_prefix.lstrip("/")
    op = accessor.operator()
    try:
        data = bytes(await op.read(key))
    except NotFound:
        data = b""
    result = data[:length].ljust(length, b"\0")
    await op.write(key, result)
