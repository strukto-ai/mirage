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


async def delete_replaced(drive: DriveApi, row: FileStat) -> None:
    """Delete the item a move or copy replaced, while it is still there.

    Drive deletes by id wherever the item went, so it is read again
    first: one another writer trashed, renamed or moved while the
    replacement landed no longer holds the destination and is left as it
    is. Drive has no conditional delete; reading it just before leaves
    one request for another writer's move to land in.

    Args:
        drive (DriveApi): the Drive client.
        row (FileStat): the item as the destination's row read it.
    """
    file_id = row.extra["file_id"]
    live = await drive.get_file(file_id)
    if live.get("trashed"):
        return
    there = stat_from_item(live)
    parents = row.extra.get("parents")
    if there.name != row.name or (
        parents is not None
        and set(there.extra.get("parents", [])) != set(parents)
    ):
        return
    await drive.delete_file(file_id)


async def _copied_as(
    drive: DriveApi,
    md5: str | None,
    name: str,
    folder_id: str,
    replaced: FileStat,
) -> dict[str, Any] | None:
    """The copy a copy onto ``name`` landed in ``folder_id``: an item of
    that name there, other than the one it replaces, with the source's
    md5. None when there is none, or no md5 (a Google file) to tell it by.

    Args:
        drive (DriveApi): the Drive client.
        md5 (str | None): the source's md5, as its row read it.
        name (str): the Drive name the copy lands under.
        folder_id (str): the folder it lands in.
        replaced (FileStat): the destination it replaces.
    """
    if not md5:
        return None
    listed = await drive.list_files(
        folder_id, drive_id=replaced.extra.get("drive_id")
    )
    for item in listed:
        if (
            item.get("name") == name
            and item.get("id") != replaced.extra["file_id"]
            and item.get("md5Checksum") == md5
        ):
            return dict(item)
    return None


async def gone(drive: DriveApi, file_id: str) -> bool:
    """Whether an item is gone from Drive, or sits in its trash.

    Args:
        drive (DriveApi): the Drive client.
        file_id (str): the item's id.
    """
    try:
        live = await drive.get_file(file_id, "id,trashed")
    except GoogleApiError as exc:
        if exc.status == 404:
            return True
        raise
    return bool(live.get("trashed"))


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
    name in a folder allow (``delete_replaced``): a refused copy leaves it
    as it was, and a refused delete drops the copy again and names the
    destination, as cp's refused create does; a copy whose answer was
    lost is found by its md5 (``_copied_as``). Both paths naming one item
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
    if dst_entry is None:
        item = await drive.copy_file(src_node.id, name, dst_parent_id)
        return stat_from_item(item) if isinstance(item, dict) else None
    replaced = dst_entry
    md5 = entry.extra.get("md5_checksum")

    async def retire() -> None:
        try:
            await delete_replaced(drive, replaced)
        except GoogleApiError as err:
            if err.status == 403:
                raise eacces(dst.virtual) from err
            raise

    item = await land_then_retire(
        lambda: drive.copy_file(src_node.id, name, dst_parent_id),
        lambda made: drive.delete_file(made["id"]),
        retire,
        lambda: gone(drive, replaced.extra["file_id"]),
        arrived=lambda: _copied_as(drive, md5, name, dst_parent_id, replaced),
    )
    return stat_from_item(item) if isinstance(item, dict) else None
