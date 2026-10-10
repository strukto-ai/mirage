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

import posixpath
from functools import partial
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.config import ListedMiss
from mirage.cache.index.ram import ListingCheckStore
from mirage.cache.index.warm import entry_or_listed_miss
from mirage.core.dropbox.api import get_metadata
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.constants import CONTENT_HASH, MISS_SUMMARIES
from mirage.core.dropbox.fingerprint import token_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.readdir import readdir
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of


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
    # Only a not_found or not_folder 409 is a miss; any other names a path
    # that may exist. get_metadata matches names case-insensitively.
    try:
        entry = await get_metadata(
            accessor.token_manager, dropbox_path_of(accessor, path)
        )
    except DropboxApiError as exc:
        if exc.status == 409 and exc.summary.startswith(MISS_SUMMARIES):
            raise enoent(path.virtual) from exc
        raise
    if entry.get("name") != posixpath.basename(path.vfs_path.strip("/")):
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
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        parent = PathSpec(
            virtual=parent_virtual,
            directory=parent_virtual,
            vfs_path=mount_key(parent_virtual, prefix),
        )
        found = await entry_or_listed_miss(
            index, virtual_key, partial(readdir, accessor, parent, index=index)
        )
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
