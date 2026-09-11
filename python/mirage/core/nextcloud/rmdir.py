from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotempty


async def rmdir(accessor: NextcloudAccessor,
                path: PathSpec,
                index: IndexCacheStore = NULL_INDEX) -> None:
    """Remove an empty collection.

    WebDAV DELETE on a collection is recursive (RFC 4918 9.6.1), so this
    is the same request ``rm_r`` sends and the emptiness check is the
    only thing separating them. Without it ``rmdir`` destroyed the whole
    subtree for every caller that does not pre-check emptiness itself,
    and the command builders are the only callers that do: FUSE,
    ``ws.fs`` and the sandbox runtimes all reach the op directly.

    PROPFIND on a collection returns the collection itself, so the
    listing is read for the first entry that is not the collection --
    the same self-entry rule ``readdir`` documents -- and stops there
    rather than paging a large directory to answer a yes/no question.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): collection to remove.
        index (IndexCacheStore): accepted for the rmdir slot's shape;
            unused.
    """
    key = path.mount_path.strip("/") + "/"
    stem = key.strip("/")
    op = accessor.operator()
    has_child = False
    try:
        async for entry in await op.list(key):
            if entry.path.strip("/") != stem:
                has_child = True
                break
        if not has_child:
            await op.delete(key)
    except NotFound as exc:
        raise enoent(path) from exc
    if has_child:
        raise enotempty(path)
    await invalidate_after_unlink(path)
