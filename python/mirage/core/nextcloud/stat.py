from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    ResourceType,
)
from mirage.core.nextcloud.search import search_files
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, FindType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of, raw_path_of


def stat_of(entry: IndexEntry) -> FileStat:
    """A listed row as ``stat`` renders it, the same from the index and
    from a search.

    Args:
        entry (IndexEntry): the row.
    """
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


async def tree(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> dict[str, FileStat] | None:
    """Every file and folder under a directory, each as ``stat`` answers
    it after a listing, from Nextcloud's file search: a page of a
    thousand per request, where a walk sends one per folder. None from a
    server without the search, for a path it cannot find or that is a
    file, and when a file comes back without its length, which only a stat
    of it fills.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the directory.
        index (IndexCacheStore): unused; the search answers directly.
    """
    found = await search_files(accessor, path)
    if found is None:
        return None
    base = raw_path_of(path).strip("/")
    lead = f"/{base}/" if base else "/"
    rows: dict[str, FileStat] = {}
    for entry in found:
        if not entry.key.startswith(lead):
            continue
        folder = entry.kind is FindType.DIRECTORY
        if not folder and entry.size is None:
            return None
        name = entry.key.rsplit("/", 1)[-1]
        rows[entry.key[len(lead) :]] = stat_of(
            IndexEntry(
                id=entry.key,
                name=name,
                resource_type=(
                    ResourceType.FOLDER if folder else ResourceType.FILE
                ),
                size=entry.size,
                remote_time=entry.modified or "",
            )
        )
    return rows


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
        return stat_of(lookup.entry)
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
