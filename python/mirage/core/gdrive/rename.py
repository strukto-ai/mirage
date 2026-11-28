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
    drive_target_name,
    eacces_on_denied,
    parent_folder,
)
from mirage.errors.fs import enoent, enotempty
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)


async def _refuse_children(
    drive: DriveApi, folder: FileStat, dst: PathSpec
) -> None:
    """Refuse a folder that holds anything, as mv's "Directory not empty".

    Args:
        drive (DriveApi): the Drive client.
        folder (FileStat): the folder the move would replace.
        dst (PathSpec): its path, for the error.
    """
    children = await drive.list_files(
        folder_id=folder.extra["file_id"],
        drive_id=folder.extra.get("drive_id"),
        limit=1,
    )
    if children:
        raise enotempty(dst)


@eacces_on_denied
async def rename(
    accessor: GDriveAccessor,
    src: PathSpec,
    dst: PathSpec,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
    dst_parent: FileStat | None = None,
    dst_entry: FileStat | None = None,
) -> FileStat | None:
    """Move an item, replacing a file or an empty folder at the destination.

    Drive holds two items of one name in a folder, so the item moves first
    and what it replaces is deleted after: a refused move leaves both as
    they were, and a refused delete moves the item back. A folder is asked
    for children again just before its delete, so one added while the item
    moved is not deleted with it. Both paths naming one item (Drive lists a
    legacy item under each of its parents) is rename(2) onto itself, which
    does nothing; GNU mv refuses it by inode, which a Drive row lacks.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        src (PathSpec): the item to move.
        dst (PathSpec): where it lands.
        entry (FileStat | None): what is at ``src``.
        parent (FileStat | None): what is at ``src``'s parent path.
        dst_parent (FileStat | None): what is at ``dst``'s parent path.
        dst_entry (FileStat | None): what is at ``dst``.
    """
    drive = accessor.drive
    entry = await live_row(accessor, src, entry)
    if entry is None:
        raise enoent(src.virtual)
    file_id = entry.extra["file_id"]
    dst_entry = await live_row(accessor, dst, dst_entry)
    if dst_entry is not None and dst_entry.extra["file_id"] == file_id:
        return None
    if dst_entry is not None and dst_entry.type is FileType.DIRECTORY:
        await _refuse_children(drive, dst_entry, dst)
    src_parent_id, _ = await parent_folder(accessor, src, parent)
    dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
    mime = entry.extra.get("mime_type", "")
    name = drive_target_name(posixpath.basename(dst.vfs_path), mime)
    moved = dst_parent_id != src_parent_id
    # Drive stamps a rename as an edit, so the time goes back as rename(2)
    # keeps it, as the live row just read it. Drive has no conditional
    # update; reading it just before leaves one request for another
    # writer's edit to land in.
    body = {"name": name}
    if entry.modified:
        body["modifiedTime"] = entry.modified
    item = await drive.patch_file(
        file_id,
        body,
        add_parents=dst_parent_id if moved else None,
        remove_parents=src_parent_id if moved else None,
    )
    if dst_entry is None:
        return stat_from_item(item) if isinstance(item, dict) else None
    try:
        if dst_entry.type is FileType.DIRECTORY:
            await _refuse_children(drive, dst_entry, dst)
        await drive.delete_file(dst_entry.extra["file_id"])
    except Exception:
        back = {
            **body,
            "name": drive_target_name(posixpath.basename(src.vfs_path), mime),
        }
        try:
            await drive.patch_file(
                file_id,
                back,
                add_parents=src_parent_id if moved else None,
                remove_parents=dst_parent_id if moved else None,
            )
        except Exception as exc:
            logger.debug("could not move %s back: %s", src.virtual, exc)
        raise
    return stat_from_item(item) if isinstance(item, dict) else None
