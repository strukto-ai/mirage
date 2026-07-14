from collections.abc import AsyncIterator
from urllib.parse import quote

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.sharepoint._client import (GraphError, graph_stream, item_url,
                                            split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.versions import capture_metadata
from mirage.observe.context import record_stream, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_stream(
    accessor: SharePointAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    config = accessor.config
    drive_id = resolved.drive_id
    item_p = resolved.item_path
    pinned = revision_for(virtual)
    rec = record_stream("read", stripped, "sharepoint")
    url = item_url(drive_id, item_p, action="/content")
    auth = True
    try:
        if pinned is not None:
            action = f"/versions/{quote(pinned, safe='')}/content"
            url = item_url(drive_id, item_p, action=action)
            if rec is not None:
                rec.revision = pinned
        elif rec is not None:
            (rec.fingerprint, rec.revision,
             download_url) = await capture_metadata(accessor, path)
            if download_url:
                url = download_url
                auth = False
        async for chunk in graph_stream(config, url, chunk_size, auth=auth):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise


async def range_read(accessor: SharePointAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    return await read_bytes(accessor,
                            path,
                            offset=start,
                            size=end - start,
                            index=NULL_INDEX)
