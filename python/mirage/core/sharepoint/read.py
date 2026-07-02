import time
from urllib.parse import quote

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.sharepoint._client import (GraphError, graph_get_bytes,
                                            item_url, split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.core.sharepoint.versions import capture_metadata
from mirage.observe.context import active_recorder, record, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _range_header(offset: int, size: int | None) -> str | None:
    if not offset and size is None:
        return None
    end = (offset + size - 1) if size is not None else ""
    return f"bytes={offset}-{end}"


async def read_bytes(accessor: SharePointAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = None,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    config = accessor.config
    drive_id = resolved.drive_id
    item_p = resolved.item_path
    pinned = revision_for(virtual)
    range_header = _range_header(offset, size)
    start_ms = int(time.monotonic() * 1000)
    fingerprint = None
    revision = pinned
    try:
        if pinned:
            action = f"/versions/{quote(pinned, safe='')}/content"
            url = item_url(drive_id, item_p, action=action)
            data = await graph_get_bytes(config, url, range_header)
        elif active_recorder() is not None:
            fingerprint, revision, download_url = await capture_metadata(
                accessor, path)
            if download_url:
                data = await graph_get_bytes(config,
                                             download_url,
                                             range_header,
                                             auth=False)
            else:
                url = item_url(drive_id, item_p, action="/content")
                data = await graph_get_bytes(config, url, range_header)
        else:
            url = item_url(drive_id, item_p, action="/content")
            data = await graph_get_bytes(config, url, range_header)
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    record("read",
           stripped,
           "sharepoint",
           len(data),
           start_ms,
           fingerprint=fingerprint,
           revision=revision)
    return data
