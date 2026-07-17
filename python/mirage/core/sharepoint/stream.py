from collections.abc import AsyncIterator

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import stream_item
from mirage.core.sharepoint._client import split_path
from mirage.core.sharepoint._resolver import drive_loc, resolve
from mirage.core.sharepoint.read import read_bytes
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
    loc = drive_loc(resolved, stripped)
    async for chunk in stream_item(accessor.config, loc, virtual, stripped,
                                   "sharepoint", chunk_size):
        yield chunk


async def range_read(accessor: SharePointAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    return await read_bytes(accessor,
                            path,
                            offset=start,
                            size=end - start,
                            index=NULL_INDEX)
