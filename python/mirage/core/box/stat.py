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
from mirage.core.box.api import get_folder_info
from mirage.core.box.readdir import ROOT_FOLDER_ID
from mirage.core.box.readdir import readdir as _readdir
from mirage.core.box.readdir import resource_type_for, vfs_name_for
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type
from mirage.utils.key_prefix import mount_key, mount_prefix_of

logger = logging.getLogger(__name__)


def _stat_from_item(item: dict[str, Any]) -> FileStat:
    vfs_name = vfs_name_for(item["name"])
    rt = resource_type_for(item)
    if rt == "box/folder":
        return FileStat(
            name=vfs_name,
            type=FileType.DIRECTORY,
            modified=item.get("modified_at") or "",
            extra={"box_id": item["id"]},
        )
    size = item.get("size")
    remote_time = item.get("modified_at") or ""
    return FileStat(
        name=vfs_name,
        size=size if size else None,
        type=guess_type(vfs_name),
        modified=remote_time,
        fingerprint=remote_time or None,
        extra={
            "box_id": item["id"],
            "resource_type": rt,
        },
    )


async def stat(
    accessor: BoxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        # The mount root has no parent listing to inherit an mtime from;
        # fetch the folder's own metadata so find -mtime and ls -ld see a
        # real timestamp (mirrors the onedrive Graph-root stat).
        root_id = accessor.config.root_folder_id or ROOT_FOLDER_ID
        info = await get_folder_info(accessor.token_manager, root_id)
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            modified=info.get("modified_at") or "",
            extra={"box_id": root_id},
        )
    virtual_key = prefix + "/" + key if prefix else "/" + key
    result = await index.get(virtual_key)
    if result.entry is None:
        parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
        try:
            await _readdir(
                accessor,
                PathSpec(virtual=parent_virtual,
                         directory=parent_virtual,
                         resource_path=mount_key(parent_virtual, prefix)),
                index=index,
            )
        except FileNotFoundError as exc:
            logger.debug("stat populate failed for %s: %s", virtual, exc)
        result = await index.get(virtual_key)
        if result.entry is None:
            # The write-family builders (rm/mv/cp) call stat without a
            # threaded index, so the readdir above populates a NULL store
            # that can't be read back. Resolve the id directly instead.
            item = await resolve_item(accessor, path_parts(path))
            if item is None:
                raise enoent(virtual)
            return _stat_from_item(item)
    if result.entry.resource_type == "box/folder":
        return FileStat(
            name=result.entry.vfs_name or result.entry.name,
            type=FileType.DIRECTORY,
            modified=result.entry.remote_time,
            extra={"box_id": result.entry.id},
        )
    return FileStat(
        name=result.entry.vfs_name or result.entry.name,
        size=result.entry.size,
        type=guess_type(result.entry.vfs_name),
        modified=result.entry.remote_time,
        fingerprint=result.entry.remote_time or None,
        extra={
            "box_id": result.entry.id,
            "resource_type": result.entry.resource_type,
        },
    )
