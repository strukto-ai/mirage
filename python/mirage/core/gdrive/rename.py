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
    drive_target_name,
    eacces_on_denied,
    parent_folder,
)
from mirage.errors.fs import enoent, enotempty
from mirage.types import FileStat, FileType, PathSpec


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
    """Move an item, replacing what is at the destination.

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
    dst_entry = await live_row(accessor, dst, dst_entry)
    if dst_entry is not None:
        # GNU mv overwrites the destination: drop a conflicting file (or
        # empty folder) before the move. A non-empty folder conflict is mv's
        # "Directory not empty", mirroring the msgraph rename_replace.
        if dst_entry.type is FileType.DIRECTORY:
            children = await drive.list_files(
                folder_id=dst_entry.extra["file_id"],
                drive_id=dst_entry.extra.get("drive_id"),
                limit=1,
            )
            if children:
                raise enotempty(dst)
        await drive.delete_file(dst_entry.extra["file_id"])
    src_parent_id, _ = await parent_folder(accessor, src, parent)
    dst_parent_id, _ = await parent_folder(accessor, dst, dst_parent)
    name = drive_target_name(
        posixpath.basename(dst.vfs_path), entry.extra.get("mime_type", "")
    )
    add_parents = dst_parent_id if dst_parent_id != src_parent_id else None
    remove_parents = src_parent_id if add_parents else None
    # Drive stamps a rename as an edit, so the time goes back as rename(2)
    # keeps it, as the live row just read it. Drive has no conditional
    # update; reading it just before leaves one request for another
    # writer's edit to land in.
    body = {"name": name}
    if entry.modified:
        body["modifiedTime"] = entry.modified
    item = await drive.patch_file(
        entry.extra["file_id"],
        body,
        add_parents=add_parents,
        remove_parents=remove_parents,
    )
    return stat_from_item(item) if isinstance(item, dict) else None
