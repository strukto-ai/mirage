from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import (NULL_INDEX, IndexCacheStore, IndexEntry,
                                ResourceType)
from mirage.core.sharepoint._client import GraphError, graph_list, item_url
from mirage.core.sharepoint._resolver import list_drives, list_sites, resolve
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent
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

    drive_id = resolved.drive_id
    item_path = resolved.item_path or ""
    url = item_url(drive_id,
                   "/" + item_path if item_path else "/",
                   action="/children")
    try:
        children = await graph_list(accessor.config, url)
    except GraphError as exc:
        if exc.status != 404:
            raise
        info = await stat(accessor, original, index=index)
        if info.type != FileType.DIRECTORY:
            raise NotADirectoryError(virtual_key) from exc
        raise enoent(virtual_key) from exc
    base = "/" + stripped if stripped else ""
    names: list[str] = []
    index_entries: list[tuple[str, IndexEntry]] = []
    for child in children:
        cname = child.get("name", "")
        key = f"{base}/{cname}"
        names.append(key)
        if "folder" in child:
            entry = IndexEntry(id=key,
                               name=cname,
                               resource_type=ResourceType.FOLDER,
                               size=child.get("size"),
                               remote_time=child.get("lastModifiedDateTime",
                                                     ""))
        else:
            entry = IndexEntry(id=key,
                               name=cname,
                               resource_type=ResourceType.FILE,
                               size=child.get("size"),
                               remote_time=child.get("lastModifiedDateTime",
                                                     ""))
        index_entries.append((cname, entry))
    names = sorted(names)
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
