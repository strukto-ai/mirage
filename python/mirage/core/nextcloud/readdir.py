import logging

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry, ResourceType
from mirage.core.nextcloud.constants import SCOPE_ERROR
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir
from mirage.utils.key_prefix import mount_prefix_of

logger = logging.getLogger(__name__)


async def readdir(accessor: NextcloudAccessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    target = path.directory if path.pattern else path.virtual
    if prefix and target.startswith(prefix):
        rest = target[len(prefix):]
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
    try:
        async for entry in await op.list(list_path):
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
            entry_obj = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FOLDER,
                                   remote_time=times.get(e, ""))
        else:
            entry_obj = IndexEntry(id=e,
                                   name=name,
                                   resource_type=ResourceType.FILE,
                                   size=sizes.get(e),
                                   remote_time=times.get(e, ""))
        index_entries.append((name, entry_obj))
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
