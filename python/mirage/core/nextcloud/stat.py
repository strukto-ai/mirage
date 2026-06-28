from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore, ResourceType
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


async def stat(accessor: NextcloudAccessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> FileStat:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    original_prefix = path.prefix
    raw = path.original
    if original_prefix and raw.startswith(original_prefix):
        raw = raw[len(original_prefix):] or "/"
    stripped = raw.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is not None:
        virtual_key = (original_prefix + "/" +
                       stripped if original_prefix else "/" + stripped)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            entry = lookup.entry
            if entry.resource_type == ResourceType.FOLDER:
                return FileStat(name=entry.name,
                                type=FileType.DIRECTORY,
                                modified=entry.remote_time or None)
            return FileStat(name=entry.name,
                            size=entry.size,
                            modified=entry.remote_time or None,
                            type=guess_type(entry.name))
        parent = virtual_key.rsplit("/", 1)[0] or "/"
        parent_listing = await index.list_dir(parent)
        if parent_listing.entries is not None:
            raise enoent(path)
    op = accessor.operator()
    key = stripped
    try:
        md = await op.stat(key)
    except NotFound:
        md = None
    if md is not None and md.mode != EntryMode.Dir:
        modified = md.last_modified.isoformat() if md.last_modified else None
        return FileStat(
            name=stripped.rsplit("/", 1)[-1],
            size=md.content_length,
            modified=modified,
            type=guess_type(raw),
            fingerprint=md.etag,
            extra={"etag": md.etag} if md.etag else {},
        )
    try:
        md_dir = await op.stat(key + "/")
        if md_dir and md_dir.mode == EntryMode.Dir:
            return FileStat(
                name=stripped.rsplit("/", 1)[-1] or "/",
                type=FileType.DIRECTORY,
            )
    except NotFound:
        pass
    raise enoent(path)
