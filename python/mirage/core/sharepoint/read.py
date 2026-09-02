from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import read_item
from mirage.core.sharepoint.client import split_path
from mirage.core.sharepoint.resolve import drive_loc, resolve
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(accessor: SharePointAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    """Read a drive item's bytes, optionally a byte window of them.

    The index holds nothing this read wants -- Graph addresses an item
    by path -- but it still carries one fact: ``index.fresh`` is the
    dispatcher's "no memory answers this one". The site and drive ids
    are a memory, and they live on the resolver rather than here, so
    the flag has to be forwarded or a fresh read would still address
    the drive that used to hold this name.

    Args:
        accessor (SharePointAccessor): backend accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): injected index cache; read only for
            its ``fresh`` marker.
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    resolved = await resolve(accessor, path, index.fresh)
    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)
    return await read_item(accessor.config,
                           drive_loc(accessor.config, resolved, stripped),
                           virtual,
                           stripped,
                           "sharepoint",
                           offset=offset,
                           size=size,
                           session=accessor.pool)
