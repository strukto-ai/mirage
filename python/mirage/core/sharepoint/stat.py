from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore, ResourceType
from mirage.core.sharepoint._client import (GraphError, graph_get, item_url,
                                            split_path)
from mirage.core.sharepoint._resolver import resolve
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


def _entry_stat(item: dict) -> FileStat:
    name = item.get("name", "")
    if "folder" in item:
        return FileStat(name=name,
                        type=FileType.DIRECTORY,
                        size=item.get("size"),
                        modified=item.get("lastModifiedDateTime"))
    return FileStat(
        name=name,
        size=item.get("size"),
        modified=item.get("lastModifiedDateTime"),
        type=guess_type(name),
        fingerprint=item.get("cTag"),
        extra={
            "id": item.get("id"),
            "ctag": item.get("cTag"),
            "etag": item.get("eTag"),
        },
    )


async def stat(accessor: SharePointAccessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)

    resolved = await resolve(accessor, path)

    if resolved.level == "site":
        if resolved.site_id is None:
            raise enoent(virtual)
        return FileStat(name=stripped, type=FileType.DIRECTORY)

    if resolved.level == "drive":
        if resolved.drive_id is None:
            raise enoent(virtual)
        return FileStat(name=stripped.rsplit("/", 1)[-1],
                        type=FileType.DIRECTORY)

    if resolved.drive_id is None or resolved.item_path is None:
        raise enoent(virtual)

    if index is not None:
        virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped)
        lookup = await index.get(virtual_key)
        if lookup.entry is not None:
            entry = lookup.entry
            if entry.resource_type == ResourceType.FOLDER:
                return FileStat(name=entry.name,
                                type=FileType.DIRECTORY,
                                size=entry.size,
                                modified=entry.remote_time or None)
            return FileStat(name=entry.name,
                            size=entry.size,
                            modified=entry.remote_time or None,
                            type=guess_type(entry.name))
        parent = virtual_key.rsplit("/", 1)[0] or "/"
        parent_listing = await index.list_dir(parent)
        if parent_listing.entries is not None:
            raise enoent(virtual)

    try:
        item = await graph_get(accessor.config,
                               item_url(resolved.drive_id, resolved.item_path))
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    return _entry_stat(item)
