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

from functools import partial

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.warm import entry_or_warm
from mirage.core.gdrive import DIRECTORY_RESOURCE_TYPES
from mirage.core.gdrive.readdir import readdir as _readdir
from mirage.core.gdrive.resolve import resolve_key
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT, get_file
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import content_type_for_path
from mirage.utils.key_prefix import mount_key, mount_prefix_of

_MIME_TO_RT = {
    "application/vnd.google-apps.document": "gdrive/gdoc",
    "application/vnd.google-apps.spreadsheet": "gdrive/gsheet",
    "application/vnd.google-apps.presentation": "gdrive/gslide",
}


async def stat_from_api(accessor: GDriveAccessor, key: str,
                        virtual: str) -> FileStat:
    """Resolve a stat with direct Drive queries when the index can't answer.

    Generic write commands (cp/mv/rm) stat without an index, and gdrive is
    id-addressed, so a cold cache must not read as ENOENT.

    Args:
        accessor (GDriveAccessor): backend accessor.
        key (str): mount-relative path.
        virtual (str): full virtual path, for error messages.
    """
    node = await resolve_key(accessor, key)
    if node is None:
        raise enoent(virtual)
    item = await get_file(accessor.token_manager, node.id)
    modified = item.get("modifiedTime", "")
    if node.mime_type == FOLDER_MIME:
        return FileStat(name=node.name,
                        type=FileType.DIRECTORY,
                        modified=modified,
                        extra={"file_id": node.id})
    ext = MIME_TO_EXT.get(node.mime_type)
    vfs_name = f"{node.name}{ext}" if ext else node.name
    # Native renders are size-unknown (see the CLAUDE.md FileStat.size rule).
    size = None if ext else int(item.get("size") or 0)
    return FileStat(
        name=vfs_name,
        size=size,
        type=FileType.FILE,
        content=content_type_for_path(vfs_name),
        modified=modified,
        fingerprint=modified or None,
        extra={
            "file_id": node.id,
            "resource_type": _MIME_TO_RT.get(node.mime_type, "gdrive/file"),
        },
    )


async def stat(
    accessor: GDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    key = path.resource_path
    if not key:
        return FileStat(name="/", type=FileType.DIRECTORY)
    virtual_key = prefix + "/" + key if prefix else "/" + key
    parent_virtual = virtual_key.rsplit("/", 1)[0] or "/"
    # A parent that cannot be listed at all leaves the API probe as the
    # authority; entry_or_warm decides which failures get that far.
    warm = partial(
        _readdir,
        accessor,
        PathSpec(virtual=parent_virtual,
                 directory=parent_virtual,
                 resource_path=mount_key(parent_virtual, prefix)),
        index=index,
    )
    entry = await entry_or_warm(index, virtual_key, warm)
    if entry is None:
        return await stat_from_api(accessor, key, virtual)
    if entry.resource_type in DIRECTORY_RESOURCE_TYPES:
        return FileStat(
            name=entry.vfs_name,
            type=FileType.DIRECTORY,
            modified=entry.remote_time,
            extra={"file_id": entry.id},
        )
    return FileStat(
        name=entry.vfs_name or entry.name,
        size=entry.size,
        type=FileType.FILE,
        content=content_type_for_path(entry.vfs_name),
        modified=entry.remote_time,
        fingerprint=entry.remote_time or None,
        extra={
            "file_id": entry.id,
            "resource_type": entry.resource_type,
        },
    )
