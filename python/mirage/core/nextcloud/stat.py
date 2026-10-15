from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.core.nextcloud.search import search_files
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, FindType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import raw_path_of


def stat_of(
    name: str, folder: bool, size: int | None, modified: str
) -> FileStat:
    """A listed row as ``stat`` renders it, the same from a listing and
    from a search.

    Args:
        name (str): the entry's name.
        folder (bool): whether it is a folder.
        size (int | None): a file's byte length.
        modified (str): its last-modified stamp, empty when unknown.
    """
    if folder:
        return FileStat(
            name=name, type=FileType.DIRECTORY, modified=modified or None
        )
    return FileStat(
        name=name,
        size=size,
        modified=modified or None,
        type=FileType.FILE,
        content=content_type_for_path(name),
    )


async def tree(
    accessor: NextcloudAccessor, path: PathSpec
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
            name, folder, entry.size, entry.modified or ""
        )
    return rows


async def stat(accessor: NextcloudAccessor, path: PathSpec) -> FileStat:
    """What is at ``path``, asked by its WebDAV path.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): the path.
    """
    raw = raw_path_of(path)
    stripped = raw.strip("/")
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)
    op = accessor.operator()
    try:
        md = await op.stat(stripped)
    except NotFound as exc:
        raise enoent(path) from exc
    modified = md.last_modified.isoformat() if md.last_modified else None
    if md.mode == EntryMode.Dir:
        return FileStat(
            name=stripped.rsplit("/", 1)[-1] or "/",
            type=FileType.DIRECTORY,
            modified=modified,
        )
    return FileStat(
        name=stripped.rsplit("/", 1)[-1],
        size=md.content_length,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(raw),
        fingerprint=md.etag,
        extra={"etag": md.etag} if md.etag else {},
    )
