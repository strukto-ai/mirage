from functools import partial

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.msgraph.drive_ops import readdir_items
from mirage.core.sharepoint._resolver import (drive_loc, list_drives,
                                              list_sites, resolve)
from mirage.core.sharepoint.stat import stat
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def readdir(accessor: SharePointAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
    original = path
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    stripped = raw.strip("/")
    virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped) \
        if stripped else (prefix or "/")
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries

    resolved = await resolve(accessor, path)

    if resolved.level == "root":
        sites = await list_sites(accessor)
        names = sorted("/" + s for s in sites)
        index_entries = [(s,
                          IndexEntry(id="/" + s,
                                     name=s,
                                     resource_type=ResourceType.FOLDER,
                                     size=None,
                                     remote_time="")) for s in sites]
        await index.set_dir(virtual_key, index_entries)
        virtual_entries = sorted((prefix + e if prefix else e) for e in names)
        return virtual_entries

    if resolved.level == "site" and resolved.site_id is not None:
        drives = await list_drives(accessor, resolved.site_id)
        base = "/" + stripped if stripped else ""
        names = sorted(f"{base}/{d}" for d in drives)
        index_entries = [(d,
                          IndexEntry(id=f"{base}/{d}",
                                     name=d,
                                     resource_type=ResourceType.FOLDER,
                                     size=None,
                                     remote_time="")) for d in drives]
        await index.set_dir(virtual_key, index_entries)
        virtual_entries = sorted((prefix + e if prefix else e) for e in names)
        return virtual_entries

    if resolved.drive_id is None:
        return []

    return await readdir_items(accessor.config, drive_loc(resolved, stripped),
                               index, prefix, stripped, virtual_key,
                               partial(stat, accessor, original, index))
