from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint._client import (graph_put_bytes, item_url,
                                            split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def create(accessor: SharePointAccessor, path: PathSpec) -> None:
    virtual = path.original if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    url = item_url(resolved.drive_id, resolved.item_path, action="/content")
    await graph_put_bytes(accessor.config, url, b"")
    await invalidate_after_write(path)
