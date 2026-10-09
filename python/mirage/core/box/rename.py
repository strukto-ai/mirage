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
from mirage.cache.context import invalidate_after_move
from mirage.cache.types import WriteCondition
from mirage.core.box.api import (
    update_file,
    update_folder,
)
from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import replace_file, retaken
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.core.box.rmdir import delete_empty_folder
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec


async def rename(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Move a file or folder with Box's own move.

    Only a destination it replaces is measured: Box moves the item whole,
    so a write that landed on the source moves with it. Both ends are
    recorded, since the source left and the destination was replaced.

    Args:
        accessor (BoxAccessor): Box accessor.
        src (PathSpec): the item to move.
        dst (PathSpec): where it lands.
    """
    tm = accessor.token_manager
    src_parts = path_parts(src)
    dst_parts = path_parts(dst)
    item = await resolve_item(accessor, src_parts)
    if item is None:
        raise enoent(src.virtual)
    dst_parent = await resolve_parent_id(accessor, dst_parts)
    if dst_parent is None:
        raise enoent(dst.virtual)
    new_name = dst_parts[-1]
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
    existing = await resolve_item(accessor, dst_parts)
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
            await update_folder(
                tm, item["id"], name=new_name, parent_id=dst_parent
            )
        else:
            await update_file(
                tm, item["id"], name=new_name, parent_id=dst_parent
            )
    except BoxApiError as exc:
        lost = await retaken(exc, cond, dst)
        if lost is not None:
            raise lost from exc
        raise
    # Only a folder has a subtree to drop, and only a positive "file"
    # rules one out. The type checks above refused a file onto a folder,
    # so dst held nothing below it unless the moved item is a folder.
    folder = item.get("type") != "file"
    op = "rename_prefix" if folder else "rename"
    record(op, src.virtual, "box", 0, timer)
    record(op, dst.virtual, "box", 0, timer)
    await invalidate_after_move(dst, folder)
    await invalidate_after_move(src, folder)
    lift_lost(src, upto, subtree=folder)
    lift_lost(dst, upto, subtree=folder)
