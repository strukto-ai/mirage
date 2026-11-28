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
from typing import Any

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.api.replace import land_then_retire
from mirage.core.gdrive.api import DriveApi
from mirage.core.gdrive.copy import delete_replaced, gone
from mirage.core.gdrive.readdir import live_row, stat_from_item
from mirage.core.gdrive.resolve import (
    drive_target_name,
    eacces_on_denied,
    parent_folder,
)
from mirage.errors.fs import enoent, enotempty
from mirage.types import FileStat, FileType, PathSpec


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


async def _move(
    drive: DriveApi,
    file_id: str,
    body: dict[str, Any],
    to_parent: str,
    from_parent: str,
) -> dict[str, Any]:
    """Patch an item, moving it between folders when they differ.

    Args:
        drive (DriveApi): the Drive client.
        file_id (str): the item's id.
        body (dict[str, Any]): its new name and times.
        to_parent (str): the folder it lands in.
        from_parent (str): the folder it leaves.
    """
    moved = to_parent != from_parent
    return await drive.patch_file(
        file_id,
        body,
        add_parents=to_parent if moved else None,
        remove_parents=from_parent if moved else None,
    )


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
    and what it replaces is deleted after (``delete_replaced``): a refused
    move leaves both as they were, and a refused delete moves the item
    back. A folder is asked for children again just before its delete, so
    one added while the item moved is not deleted with it. Both paths
    naming one item (Drive lists a legacy item under each of its parents)
    is rename(2) onto itself, which does nothing; GNU mv refuses it by
    inode, which a Drive row lacks.

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
    # Drive stamps a rename as an edit, so the time goes back as rename(2)
    # keeps it, as the live row just read it. Drive has no conditional
    # update; reading it just before leaves one request for another
    # writer's edit to land in.
    body = {"name": name}
    if entry.modified:
        body["modifiedTime"] = entry.modified
    back = {
        **body,
        "name": drive_target_name(posixpath.basename(src.vfs_path), mime),
    }
    if dst_entry is None:
        item = await _move(drive, file_id, body, dst_parent_id, src_parent_id)
        return stat_from_item(item) if isinstance(item, dict) else None
    replaced = dst_entry

    async def retire() -> None:
        if replaced.type is FileType.DIRECTORY:
            await _refuse_children(drive, replaced, dst)
        await delete_replaced(drive, replaced)

    item = await land_then_retire(
        lambda: _move(drive, file_id, body, dst_parent_id, src_parent_id),
        lambda _: _move(drive, file_id, back, src_parent_id, dst_parent_id),
        retire,
        lambda: gone(drive, replaced.extra["file_id"]),
    )
    return stat_from_item(item) if isinstance(item, dict) else None
