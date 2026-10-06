import logging
from collections.abc import Awaitable, Callable

from opendal.exceptions import NotFound
from opendal.types import EntryMode

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import (
    NULL_INDEX,
    IndexCacheStore,
    IndexEntry,
    ResourceType,
)
from mirage.core.nextcloud.constants import SCOPE_ERROR
from mirage.errors.fs import enoent, enotdir, listing_error
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


def _kind_probes(
    accessor: NextcloudAccessor,
) -> tuple[Callable[[str], Awaitable[bool]], Callable[[str], Awaitable[bool]]]:
    """``is_file`` and ``is_dir`` probes that share one PROPFIND per key.

    One stat answers both, a collection included, so a walk asking each
    of a component in turn sends one request for it rather than two.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
    """
    kinds: dict[str, EntryMode | None] = {}

    async def kind(key: str) -> EntryMode | None:
        stripped = key.strip("/")
        if stripped not in kinds:
            try:
                md = await accessor.operator().stat(stripped)
            except NotFound:
                kinds[stripped] = None
            else:
                kinds[stripped] = md.mode
        return kinds[stripped]

    async def is_file(key: str) -> bool:
        mode = await kind(key)
        return mode is not None and mode != EntryMode.Dir

    async def is_dir(key: str) -> bool:
        return await kind(key) == EntryMode.Dir

    return is_file, is_dir


async def readdir(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    target = path.directory if path.pattern else path.virtual
    if prefix and target.startswith(prefix):
        rest = target[len(prefix) :]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            target = rest or "/"
    virtual_key = (prefix + target if prefix else target).rstrip("/") or "/"
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries
    list_path = target.strip("/")
    list_path = list_path + "/" if list_path else "/"
    op = accessor.operator()
    names: list[str] = []
    dir_keys: set[str] = set()
    sizes: dict[str, int | None] = {}
    times: dict[str, str] = {}
    saw_entry = False
    try:
        async for entry in await op.list(list_path):
            saw_entry = True
            relative = entry.path
            if not relative or relative == list_path:
                continue
            is_dir = relative.endswith("/")
            base = "/" + relative.rstrip("/")
            names.append(base)
            meta = entry.metadata
            if meta and meta.last_modified:
                times[base] = meta.last_modified.isoformat()
            if is_dir:
                dir_keys.add(base)
            else:
                sizes[base] = meta.content_length if meta else None
    except NotFound as exc:
        raise enoent(path) from exc
    if not saw_entry and target.strip("/"):
        # PROPFIND on a collection lists the collection itself, so an empty
        # directory still yields one entry and only a path the server does
        # not have yields none. The lister reports that as an empty result
        # rather than raising, so without this `ls /nextcloud/never`
        # rendered an empty directory and exited 0. The mount root is
        # exempt: it exists because it is mounted.
        raise await listing_error(path, target, *_kind_probes(accessor))
    # PROPFIND normally carries getcontentlength for every file; when the
    # lister omits the metadata, one stat per affected file fills the gap
    # so the index never caches an unknown size.
    for base, size in sizes.items():
        if size is None:
            md = await op.stat(base.lstrip("/"))
            sizes[base] = md.content_length
            if md.last_modified and base not in times:
                times[base] = md.last_modified.isoformat()
    # WebDAV PROPFIND on a file returns the file itself; POSIX readdir of a
    # non-directory raises ENOTDIR instead.
    target_key = "/" + target.strip("/")
    if names == [target_key] and target_key not in dir_keys:
        raise enotdir(path)
    names = sorted(names)
    if len(names) > SCOPE_ERROR:
        logger.warning(
            "nextcloud readdir: %s returned %d entries (limit %d)",
            virtual_key,
            len(names),
            SCOPE_ERROR,
        )
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    index_entries: list[tuple[str, IndexEntry]] = []
    for e in names:
        name = e.rsplit("/", 1)[-1]
        if e in dir_keys:
            entry_obj = IndexEntry(
                id=e,
                name=name,
                resource_type=ResourceType.FOLDER,
                remote_time=times.get(e, ""),
            )
        else:
            entry_obj = IndexEntry(
                id=e,
                name=name,
                resource_type=ResourceType.FILE,
                size=sizes.get(e),
                remote_time=times.get(e, ""),
            )
        index_entries.append((name, entry_obj))
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
