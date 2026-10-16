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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.readdir import live_row, stat_from_item
from mirage.core.gdrive.resolve import (
    DriveNode,
    drive_target_name,
    eacces_on_denied,
    node_from_item,
    node_of,
    parent_folder,
)
from mirage.core.google.client import TokenManager
from mirage.core.google.drive import (
    copy_file,
    create_folder,
    delete_file,
    list_files,
)
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.types import FileStat, FileType, PathSpec


async def copy_children(
    token_manager: TokenManager, src: DriveNode, dst_folder_id: str
) -> None:
    """Recursively copy a folder's children into a destination folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        src (DriveNode): source folder.
        dst_folder_id (str): destination folder id.
    """
    children = await list_files(
        token_manager, folder_id=src.id, drive_id=src.drive_id
    )
    for item in children:
        child = node_from_item(item, src.drive_id)
        if child.is_folder:
            created = await create_folder(
                token_manager, child.name, dst_folder_id
            )
            await copy_children(token_manager, child, created["id"])
        else:
            await copy_file(token_manager, child.id, child.name, dst_folder_id)


@eacces_on_denied
async def copy(
    accessor: GDriveAccessor,
    src: PathSpec,
    dst: PathSpec,
    entry: FileStat | None = None,
    dst_parent: FileStat | None = None,
    dst_entry: FileStat | None = None,
) -> FileStat | None:
    """Copy a file or folder server-side.

    ``cp -r`` merges into an existing folder and creates a missing one,
    mirroring the msgraph copy_tree.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
        entry (FileStat | None): what is at ``src``.
        dst_parent (FileStat | None): what is at ``dst``'s parent path.
        dst_entry (FileStat | None): what is at ``dst``.

    Returns:
        FileStat | None: the stat of what the copy made, None when it
            merged into a folder already there.
    """
    if entry is None:
        raise enoent(src.virtual)
    token_manager = accessor.token_manager
    dst_entry = await live_row(accessor, dst, dst_entry)
    src_node = node_of(entry)
    if src_node.is_folder:
        if dst_entry is not None and dst_entry.type is not FileType.DIRECTORY:
            raise enotdir(dst.virtual)
        made = None
        if dst_entry is None:
            dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
            created = await create_folder(
                token_manager, posixpath.basename(dst.vfs_path), dst_parent_id
            )
            dst_id = created["id"]
            made = stat_from_item(created)
        else:
            dst_id = dst_entry.extra["file_id"]
        await copy_children(token_manager, src_node, dst_id)
        return made
    if dst_entry is not None and dst_entry.type is FileType.DIRECTORY:
        raise eisdir(dst.virtual)
    if dst_entry is not None:
        await delete_file(token_manager, dst_entry.extra["file_id"])
    dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
    name = drive_target_name(
        posixpath.basename(dst.vfs_path), src_node.mime_type
    )
    item = await copy_file(token_manager, src_node.id, name, dst_parent_id)
    return stat_from_item(item) if isinstance(item, dict) else None
