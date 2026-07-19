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

import logging
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import get_metadata
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def _stat_from_entry(entry: dict[str, Any]) -> FileStat:
    modified = entry.get("server_modified") or entry.get(
        "client_modified") or ""
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
        size=size if isinstance(size, int) and size > 0 else None,
        type=guess_type(name),
        modified=modified,
        fingerprint=modified or None,
        extra={
            "dropbox_id": entry_id,
            "resource_type": "dropbox/file",
        },
    )


async def _stat_from_api(accessor: DropboxAccessor,
                         path: PathSpec) -> FileStat:
    # API-truthful stat for index-less callers (unlink/rmdir
    # classification, walk fallbacks): get_metadata resolves directly.
    try:
        entry = await get_metadata(accessor.token_manager,
                                   dropbox_path_of(accessor, path))
    except DropboxApiError as exc:
        if exc.status == 409:
            raise enoent(path.virtual) from exc
        raise
    return _stat_from_entry(entry)


async def stat(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)
    if index is NULL_INDEX:
        return await _stat_from_api(accessor, path)
    virtual_key = prefix + "/" + key if prefix else "/" + key

    result = await index.get(virtual_key)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await readdir(
                accessor,
                PathSpec(virtual=parent_virtual,
                         directory=parent_virtual,
                         resource_path=mount_key(parent_virtual, prefix)),
                index=index,
            )
        except (FileNotFoundError, DropboxApiError) as exc:
            # Parent listing failed (missing dir surfaces as a 409 from
            # the API): fall through to enoent, mirroring the TS stat.
            logger.debug("stat populate failed for %s: %s", virtual, exc)
        result = await index.get(virtual_key)
        if result.entry is None:
            raise enoent(virtual)
    if result.entry.resource_type == "dropbox/folder":
        return FileStat(
            name=result.entry.vfs_name or result.entry.name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time,
            extra={"dropbox_id": result.entry.id},
        )
    return FileStat(
        name=result.entry.vfs_name or result.entry.name,
        size=result.entry.size,
        type=guess_type(result.entry.vfs_name),
        modified=result.entry.remote_time,
        fingerprint=result.entry.remote_time or None,
        extra={
            "dropbox_id": result.entry.id,
            "resource_type": result.entry.resource_type,
        },
    )
