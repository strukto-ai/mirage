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

from mirage.accessor.box import BoxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.box.api import absent_on_404, get_file_info, get_folder_info
from mirage.core.box.client import BoxApiError
from mirage.core.box.constants import SHA1
from mirage.core.box.fingerprint import entry_token, token_of
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.readdir import resource_type_for
from mirage.core.box.resolve import (
    names_this_path,
    path_parts,
    resolve_item,
    root_id,
)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def _stat_from_item(item: dict[str, Any]) -> FileStat:
    vfs_name = item["name"]
    rt = resource_type_for(item)
    if rt == "box/folder":
        return FileStat(
            name=vfs_name,
            type=FileType.DIRECTORY,
            modified=item.get("modified_at") or "",
            extra={"box_id": item["id"]},
        )
    sha1 = token_of(item.get(SHA1))
    return FileStat(
        name=vfs_name,
        size=item.get("size"),
        type=FileType.FILE,
        content=content_type_for_path(vfs_name),
        modified=item.get("modified_at") or "",
        fingerprint=sha1,
        extra={
            "box_id": item["id"],
            "resource_type": rt,
            **({SHA1: sha1} if sha1 else {}),
        },
    )


async def _point_stat(
    accessor: BoxAccessor,
    path: PathSpec,
    index: ListingCheckStore,
    virtual_key: str,
) -> FileStat | None:
    """Stat one file with one request by the id the mount last listed.

    Only a scratch store asks this way: the reconcile probe builds one over
    the mount's index, so the cached row is a lead, never an answer. Its id
    addresses one ``GET /files/{id}``, and every field the verdict reads
    (sha1, name, ancestry, status) comes back live. Anything that is not
    the active file at exactly this path answers None, and the caller walks
    the listings as it always has; only that walk may call a path gone, so
    a 404 or 403 here is a fallback, not ENOENT.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path being checked.
        index (ListingCheckStore): the probe's scratch store.
        virtual_key (str): the mount-absolute key ``stat`` looked up.
    """
    hint = await index.hint(virtual_key)
    if hint is None or hint.resource_type != "box/file" or not hint.id:
        return None
    try:
        item = await get_file_info(accessor.token_manager, hint.id)
    except BoxApiError as exc:
        if exc.status not in (403, 404):
            raise
        logger.debug("hinted id for %s unusable: %s", path.virtual, exc)
        return None
    if not names_this_path(accessor, item, path):
        return None
    return _stat_from_item(item)


async def stat(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    key = path.vfs_path
    if not key:
        # The mount root has no parent listing to inherit an mtime from;
        # fetch the folder's own metadata so find -mtime and ls -ld see a
        # real timestamp (mirrors the onedrive Graph-root stat).
        folder_id = root_id(accessor)
        info = await absent_on_404(
            virtual, lambda: get_folder_info(accessor.token_manager, folder_id)
        )
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            modified=info.get("modified_at") or "",
            extra={"box_id": folder_id},
        )
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        if isinstance(index, ListingCheckStore):
            found = await _point_stat(accessor, path, index, virtual_key)
            if found is not None:
                return found
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(
                    virtual=parent_virtual,
                    directory=parent_virtual,
                    vfs_path=mount_key(parent_virtual, prefix),
                ),
                index=index,
            )
        except FileNotFoundError as exc:
            logger.debug("stat populate failed for %s: %s", virtual, exc)
        result = await index.get(virtual_key)
        if result.entry is None:
            # The write-family builders (rm/mv/cp) call stat without a
            # threaded index, so the readdir above populates a NULL store
            # that can't be read back. Resolve the id directly instead.
            item = await absent_on_404(
                virtual, lambda: resolve_item(accessor, path_parts(path))
            )
            if item is None or resource_type_for(item) == "box/weblink":
                # Weblinks are hidden from listings; a direct lookup must
                # not resurface a sizeless, unreadable entry.
                raise enoent(virtual)
            return _stat_from_item(item)
    if result.entry.resource_type == "box/folder":
        return FileStat(
            name=result.entry.vfs_name or result.entry.name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time,
            extra={"box_id": result.entry.id},
        )
    sha1 = entry_token(result.entry)
    return FileStat(
        name=result.entry.vfs_name or result.entry.name,
        size=result.entry.size,
        type=FileType.FILE,
        content=content_type_for_path(result.entry.vfs_name),
        modified=result.entry.remote_time,
        fingerprint=sha1,
        extra={
            "box_id": result.entry.id,
            "resource_type": result.entry.resource_type,
            **({SHA1: sha1} if sha1 else {}),
        },
    )
