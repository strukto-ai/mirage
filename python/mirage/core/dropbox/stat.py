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
import posixpath
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dropbox.api import get_metadata
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.constants import CONTENT_HASH, MISS_SUMMARIES
from mirage.core.dropbox.fingerprint import entry_token, token_of
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.readdir import readdir
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def _stat_from_entry(entry: dict[str, Any]) -> FileStat:
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
    # API-truthful stat for index-less callers (unlink/rmdir
    # classification, walk fallbacks): get_metadata resolves directly.
    # Every 409 is ENOENT here; only the fresh probe's point stat narrows
    # it, since only there does ENOENT drop an overlay.
    try:
        entry = await get_metadata(
            accessor.token_manager, dropbox_path_of(accessor, path)
        )
    except DropboxApiError as exc:
        if exc.status == 409:
            raise enoent(path.virtual) from exc
        raise
    return _stat_from_entry(entry)


async def _point_stat(accessor: DropboxAccessor, path: PathSpec) -> FileStat:
    """Stat one path with one get_metadata, writing nothing to the index.

    Only a scratch store asks this way. The reconcile probe and the
    snapshot drift check build one, and both treat ENOENT and ENOTDIR
    alike, so a miss is ENOENT with no further lookup; the drift check
    skips a mount without snapshot support, which dropbox is, so today
    only the probe gets here. Only a not_found or not_folder 409 is a
    miss: the probe calls ENOENT gone and drops the path's overlay, so a
    409 for a file that exists (restricted_content, ...) propagates and
    the probe reads it as unverifiable. get_metadata matches
    case-insensitively where a listing's names are exact, so an answer
    naming the last component in another case is not this path.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the operand.
    """
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
    return _stat_from_entry(entry)


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
    if index is NULL_INDEX:
        return await _stat_from_api(accessor, path)
    virtual_key = prefix + "/" + key if prefix else "/" + key

    result = await index.get(virtual_key)
    if result.entry is None:
        # The throwaway store a fresh probe or the drift check stats
        # through is dropped right after: ask for this one path rather
        # than list a whole folder into it. A mount's own index lists the
        # parent and keeps it, so siblings and repeats cost nothing.
        if index.scratch:
            return await _point_stat(accessor, path)
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await readdir(
                accessor,
                PathSpec(
                    virtual=parent_virtual,
                    directory=parent_virtual,
                    vfs_path=mount_key(parent_virtual, prefix),
                ),
                index=index,
            )
        except FileNotFoundError as exc:
            logger.debug(
                "stat found no parent listing for %s: %s", virtual, exc
            )
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
        type=FileType.FILE,
        content=content_type_for_path(result.entry.vfs_name),
        modified=result.entry.remote_time,
        fingerprint=entry_token(result.entry),
        extra={
            "dropbox_id": result.entry.id,
            "resource_type": result.entry.resource_type,
        },
    )
