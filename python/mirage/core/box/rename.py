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

from mirage.accessor.box import BoxAccessor
from mirage.cache.types import WriteCondition
from mirage.core.box.api import (
    update_file,
    update_folder,
)
from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import replace_file, retaken
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import item_of, parent_folder, path_parts
from mirage.core.box.rmdir import delete_empty_folder
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import FileStat, PathSpec
from mirage.utils.upload import upload_stat


async def rename(
    accessor: BoxAccessor,
    src: PathSpec,
    dst: PathSpec,
    entry: FileStat | None = None,
    dst_parent: FileStat | None = None,
    dst_entry: FileStat | None = None,
) -> FileStat | None:
    """Move a file or folder whole; only a destination it replaces is held.

    A rename onto its own name is a no-op, as rename(2) is: nothing is
    sent or recorded, so the line keeps the version it read.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to move.
        dst (PathSpec): where it lands.
        entry (FileStat | None): what is at ``src``.
        dst_parent (FileStat | None): what is at ``dst``'s parent path.
        dst_entry (FileStat | None): what is at ``dst``.

    Returns:
        FileStat | None: the item's stat where it landed, None when the
            reply names none.
    """
    tm = accessor.token_manager
    item = item_of(entry)
    if item is None:
        raise enoent(src.virtual)
    if src.virtual == dst.virtual:
        return None
    folder_id = parent_folder(accessor, dst, dst_parent)
    new_name = path_parts(dst)[-1]
    # mv overwrites the destination; Box 409s on a name clash, so clear
    # an existing dst first. A type mismatch is refused with rename(2)'s own
    # errnos and outranks emptiness, since real rename answers EISDIR for a
    # file onto a directory whether or not that directory has children. Only
    # a folder gives way to a folder, and then only an empty one: a non-empty
    # one is mv's "Directory not empty", which recursive=false gets from Box
    # for free, exactly as rmdir does.
    upto = lost_count()
    timer = start_op()
    cond: WriteCondition | None = None
    existing = item_of(dst_entry)
    if existing is None and item.get("type") == "file":
        cond = await replace_file(accessor, dst, None)
    if existing is not None and existing["id"] != item["id"]:
        src_is_folder = item.get("type") == "folder"
        if existing.get("type") == "folder":
            if not src_is_folder:
                raise eisdir(dst.virtual)
            await delete_empty_folder(tm, existing["id"], dst)
        else:
            if src_is_folder:
                raise enotdir(dst.virtual)
            cond = await replace_file(accessor, dst, existing)
    try:
        if item.get("type") == "folder":
            moved = await update_folder(
                tm, item["id"], name=new_name, parent_id=folder_id
            )
        else:
            moved = await update_file(
                tm, item["id"], name=new_name, parent_id=folder_id
            )
    except BoxApiError as exc:
        raise (await retaken(exc, cond, dst)) or exc
    # Only a folder has a subtree to drop, and only a positive "file"
    # rules one out. The type checks above refused a file onto a folder,
    # so dst held nothing below it unless the moved item is a folder.
    folder = item.get("type") != "file"
    op = "rename_prefix" if folder else "rename"
    record(op, src.virtual, "box", 0, timer)
    record(op, dst.virtual, "box", 0, timer)
    lift_lost(src, upto, subtree=folder)
    lift_lost(dst, upto, subtree=folder)
    return upload_stat(moved, stat_from_item, dst.virtual)
