# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.config import ListedMiss
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.dropbox.api import list_folder, lookup
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.constants import CONTENT_HASH
from mirage.core.dropbox.fingerprint import token_of
from mirage.core.dropbox.paths import dropbox_path_of, spelled_otherwise
from mirage.core.dropbox.readdir import dropbox_path_from_key, readdir
from mirage.core.hierarchy.probe import resolve_listed_entry
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_prefix_of


def stat_from_entry(entry: dict[str, Any]) -> FileStat:
    modified = (
        entry.get("server_modified") or entry.get("client_modified") or ""
    )
    name = entry.get("name", "")
    entry_id = entry.get("id") or entry.get("path_display") or name
    if entry.get(".tag") == "folder":
        return FileStat(
            name=name,
            type=FileType.DIRECTORY,
            modified=modified,
            extra={"dropbox_id": entry_id},
        )
    size = entry.get("size")
    return FileStat(
        name=name,
        size=size if isinstance(size, int) else None,
        type=FileType.FILE,
        content=content_type_for_path(name),
        modified=modified,
        fingerprint=token_of(entry.get(CONTENT_HASH)),
        extra={
            "dropbox_id": entry_id,
            "resource_type": "dropbox/file",
        },
    )


async def _stat_from_api(
    accessor: DropboxAccessor, path: PathSpec
) -> FileStat:
    # One get_metadata: for index-less callers, the fresh checks' store
    # and a name missing from a listing the running command did not fetch.
    entry = await lookup(
        accessor.token_manager, dropbox_path_of(accessor, path)
    )
    if entry is None or spelled_otherwise(path, entry):
        raise enoent(path.virtual)
    return stat_from_entry(entry)


async def stat(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is NULL_INDEX or isinstance(index, ListingCheckStore):
        return await _stat_from_api(accessor, path)
    virtual_key = prefix + "/" + key if prefix else "/" + key

    entry = (await index.get(virtual_key)).entry
    if entry is None:
        found = await resolve_listed_entry(readdir, accessor, path, index)
        if found is ListedMiss.UNTRUSTED:
            return await _stat_from_api(accessor, path)
        if found is None:
            raise enoent(virtual)
        entry = found
    if entry.resource_type == "dropbox/folder":
        return FileStat(
            name=entry.vfs_name or entry.name,
            type=FileType.DIRECTORY,
            modified=entry.remote_time,
            extra={"dropbox_id": entry.id},
        )
    return FileStat(
        name=entry.vfs_name or entry.name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_path(entry.vfs_name),
        modified=entry.remote_time,
        fingerprint=token_of(entry.extra.get(CONTENT_HASH)),
        extra={
            "dropbox_id": entry.id,
            "resource_type": entry.resource_type,
        },
    )


async def tree(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> dict[str, FileStat] | None:
    """Every entry under a folder from one recursive ``list_folder``,
    each as ``stat`` answers it from a listing.

    Dropbox matches paths without case, so each entry's place comes from
    its lowercased path and its name from the entry, as a listing of its
    folder names it. A folder Dropbox refuses to list (a missing path, a
    file) answers None, so the walk's readdir reports it.

    Args:
        accessor (DropboxAccessor): backend handle.
        path (PathSpec): the folder.
        index (IndexCacheStore): unused; the listing is read whole.
    """
    folder = dropbox_path_from_key(
        accessor.root_path, path.mount_path.strip("/")
    )
    try:
        entries = await list_folder(
            accessor.token_manager, folder, recursive=True
        )
    except DropboxApiError as exc:
        if exc.status == 409:
            return None
        raise
    base = folder.lower().rstrip("/")
    places: dict[str, str] = {base: ""}
    found: dict[str, FileStat] = {}
    for entry in sorted(
        entries, key=lambda e: str(e.get("path_lower", "")).count("/")
    ):
        lower = str(entry.get("path_lower", ""))
        parent, _, _ = lower.rpartition("/")
        if lower == base or parent not in places:
            continue
        above = places[parent]
        rel = f"{above}/{entry['name']}" if above else str(entry["name"])
        places[lower] = rel
        found[rel] = stat_from_entry(entry)
    return found
