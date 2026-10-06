from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, ResourceType
from mirage.core.nextcloud.util import raw_path_of
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of


async def stat(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    original_prefix = mount_prefix_of(path.virtual, path.vfs_path)
    raw = raw_path_of(path)
    stripped = raw.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    virtual_key = (
        original_prefix + "/" + stripped if original_prefix else "/" + stripped
    )
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        if entry.resource_type == ResourceType.FOLDER:
            return FileStat(
                name=entry.name,
                type=FileType.DIRECTORY,
                modified=entry.remote_time or None,
            )
        return FileStat(
            name=entry.name,
            size=entry.size,
            modified=entry.remote_time or None,
            type=FileType.FILE,
            content=content_type_for_path(entry.name),
        )
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(path)
    op = accessor.operator()
    try:
        md = await op.stat(stripped)
    except NotFound as exc:
        raise enoent(path) from exc
    if md.mode == EntryMode.Dir:
        return FileStat(
            name=stripped.rsplit("/", 1)[-1] or "/",
            type=FileType.DIRECTORY,
        )
    modified = md.last_modified.isoformat() if md.last_modified else None
    return FileStat(
        name=stripped.rsplit("/", 1)[-1],
        size=md.content_length,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(raw),
        fingerprint=md.etag,
        extra={"etag": md.etag} if md.etag else {},
    )
