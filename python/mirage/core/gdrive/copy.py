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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.api import DriveApi
from mirage.core.gdrive.readdir import live_row, stat_from_item
from mirage.core.gdrive.resolve import (
    DriveNode,
    drive_target_name,
    eacces_on_denied,
    node_from_item,
    node_of,
    parent_folder,
)
from mirage.core.google.client import GoogleApiError
from mirage.errors.fs import eacces, eisdir, enoent, enotdir
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)


async def copy_children(
    drive: DriveApi, src: DriveNode, dst_folder_id: str
) -> None:
    """Recursively copy a folder's children into a destination folder.

    Args:
        drive (DriveApi): the Drive client.
        src (DriveNode): source folder.
        dst_folder_id (str): destination folder id.
    """
    children = await drive.list_files(folder_id=src.id, drive_id=src.drive_id)
    for item in children:
        child = node_from_item(item, src.drive_id)
        if child.is_folder:
            created = await drive.create_folder(child.name, dst_folder_id)
            await copy_children(drive, child, created["id"])
        else:
            await drive.copy_file(child.id, child.name, dst_folder_id)


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
    mirroring the msgraph copy_tree. A file it replaces is deleted only
    once the copy has landed beside it, which Drive's two items of one
    name in a folder allow, so a refused copy leaves it as it was, and a
    refused delete drops the copy again and names the destination, as
    cp's refused create does. Both paths naming one item
    (Drive lists a legacy item under each of its parents) leaves nothing
    to copy; GNU cp refuses it by inode, which a Drive row lacks.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
        entry (FileStat | None): what is at ``src``.
        dst_parent (FileStat | None): what is at ``dst``'s parent path.
        dst_entry (FileStat | None): what is at ``dst``.

    Returns:
        FileStat | None: the stat of what the copy made, None when it
            merged into a folder already there or found the item itself.
    """
    if entry is None:
        raise enoent(src.virtual)
    drive = accessor.drive
    dst_entry = await live_row(accessor, dst, dst_entry)
    src_node = node_of(entry)
    if src_node.is_folder:
        if dst_entry is not None and dst_entry.type is not FileType.DIRECTORY:
            raise enotdir(dst.virtual)
        made = None
        if dst_entry is None:
            dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
            created = await drive.create_folder(
                posixpath.basename(dst.vfs_path), dst_parent_id
            )
            dst_id = created["id"]
            made = stat_from_item(created)
        else:
            dst_id = dst_entry.extra["file_id"]
        await copy_children(drive, src_node, dst_id)
        return made
    if dst_entry is not None and dst_entry.type is FileType.DIRECTORY:
        raise eisdir(dst.virtual)
    if dst_entry is not None and dst_entry.extra["file_id"] == src_node.id:
        return None
    dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
    name = drive_target_name(
        posixpath.basename(dst.vfs_path), src_node.mime_type
    )
    item = await drive.copy_file(src_node.id, name, dst_parent_id)
    if dst_entry is not None:
        try:
            await drive.delete_file(dst_entry.extra["file_id"])
        except Exception as err:
            try:
                await drive.delete_file(item["id"])
            except Exception as exc:
                logger.debug(
                    "could not drop the copy at %s: %s", dst.virtual, exc
                )
            if isinstance(err, GoogleApiError) and err.status == 403:
                raise eacces(dst.virtual) from err
            raise
    return stat_from_item(item) if isinstance(item, dict) else None
