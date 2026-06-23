import time

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.sharepoint._client import (graph_post, graph_put_bytes,
                                            item_url, split_path, upload_chunk)
from mirage.core.sharepoint._resolver import resolve
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent

SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024
UPLOAD_CHUNK = 10 * 327680


async def _upload_session(accessor: SharePointAccessor, drive_id: str,
                          item_path: str, data: bytes) -> None:
    config = accessor.config
    session_url = item_url(drive_id, item_path, action="/createUploadSession")
    session = await graph_post(config, session_url)
    upload_url = session["uploadUrl"]
    total = len(data)
    start = 0
    while start < total:
        chunk = data[start:start + UPLOAD_CHUNK]
        result = await upload_chunk(config, upload_url, chunk, start, total)
        ranges = result.get("nextExpectedRanges") if result else None
        if ranges:
            start = int(ranges[0].split("-", 1)[0])
        else:
            start += len(chunk)


async def write_bytes(accessor: SharePointAccessor, path: PathSpec,
                      data: bytes) -> None:
    virtual = path.original if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    config = accessor.config
    drive_id = resolved.drive_id
    item_p = resolved.item_path
    start_ms = int(time.monotonic() * 1000)
    if len(data) <= SIMPLE_UPLOAD_MAX:
        url = item_url(drive_id, item_p, action="/content")
        await graph_put_bytes(config, url, data)
    else:
        await _upload_session(accessor, drive_id, item_p, data)
    record("write", stripped, "sharepoint", len(data), start_ms)
    await invalidate_after_write(path)
