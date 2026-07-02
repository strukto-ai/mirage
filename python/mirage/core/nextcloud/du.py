from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: NextcloudAccessor, path: PathSpec) -> int:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    target = path.mount_path
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            if entry.path.endswith("/"):
                continue
            meta = entry.metadata
            if meta is not None:
                total += int(meta.content_length or 0)
    except NotFound:
        return 0
    return total


async def du_all(accessor: NextcloudAccessor,
                 path: PathSpec) -> list[tuple[str, int]]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return []
    target = path.mount_path
    pfx = target.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    results: list[tuple[str, int]] = []
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel or rel.endswith("/"):
                continue
            meta = entry.metadata
            sz = int(meta.content_length or 0) if meta is not None else 0
            results.append(("/" + rel.lstrip("/"), sz))
            total += sz
    except NotFound:
        pass
    results.sort()
    results.append((target, total))
    return results
