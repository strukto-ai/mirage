import time

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint.client import graph_put_bytes, item_url, split_path
from mirage.core.sharepoint.resolve import resolve
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def create(accessor: SharePointAccessor, path: PathSpec) -> None:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    start_ms = int(time.monotonic() * 1000)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    url = item_url(accessor.config,
                   resolved.drive_id,
                   resolved.item_path,
                   action="/content")
    await graph_put_bytes(accessor.config, url, b"", session=accessor.pool)
    record("create", stripped, "sharepoint", 0, start_ms)
    await invalidate_after_write(path)
