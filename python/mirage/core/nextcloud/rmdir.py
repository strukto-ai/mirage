from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.types import PathSpec


async def rmdir(accessor: NextcloudAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    key = raw.strip("/") + "/"
    op = accessor.operator()
    try:
        await op.delete(key)
    except NotFound as exc:
        raise FileNotFoundError(raw) from exc
