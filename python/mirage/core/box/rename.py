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

from collections.abc import Mapping
from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.types import WriteCondition
from mirage.core.box.api import list_folder_items
from mirage.core.box.client import BoxApiError
from mirage.core.box.copy import (
    held_file,
    place,
    replace_file,
    replace_item,
    retaken,
)
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import live_item_of, parent_folder, path_parts
from mirage.errors.fs import eisdir, enoent, enotdir, enotempty
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import FileStat, PathSpec
from mirage.utils.upload import upload_stat


def _refuse_mismatch(
    dst: PathSpec, existing: Mapping[str, Any], src: Mapping[str, Any]
) -> None:
    """Refuse a type mismatch with rename(2)'s own errnos.

    A mismatch outranks emptiness, since real rename answers EISDIR for a
    file onto a directory whether or not that directory has children.

    Args:
        dst (PathSpec): the destination.
        existing (dict[str, Any]): what is at ``dst``.
        src (dict[str, Any]): the item moving onto it.
    """
    if existing.get("type") != "folder":
        if src.get("type") == "folder":
            raise enotdir(dst.virtual)
    elif src.get("type") != "folder":
        raise eisdir(dst.virtual)


def _folder_of(item: Mapping[str, Any]) -> str | None:
    """The folder an item sits in, from a listing's ``parent`` or a
    lookup's ``path_collection``.

    Args:
        item (dict[str, Any]): the item as a listing or a lookup answered.
    """
    parent = item.get("parent")
    if isinstance(parent, Mapping) and parent.get("id"):
        return str(parent["id"])
    entries = (item.get("path_collection") or {}).get("entries") or []
    return str(entries[-1]["id"]) if entries else None


async def _replace_onto(
    accessor: BoxAccessor,
    item: Mapping[str, Any],
    dst: PathSpec,
    folder_id: str,
    existing: Mapping[str, Any],
) -> dict[str, Any]:
    """Move ``item`` onto what holds ``dst``'s name.

    A stale destination file is refused before anything is sent, and so
    is a folder that holds anything, the item itself included (``mv -T
    d/c d``). The rest is ``replace_item``, whose undo for a landed item
    moves it back to its folder and name.

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): the item moving.
        dst (PathSpec): where it lands.
        folder_id (str): the folder ``dst`` is in.
        existing (dict[str, Any]): what is at ``dst``.
    """
    _refuse_mismatch(dst, existing, item)
    tm = accessor.token_manager
    new_name = path_parts(dst)[-1]
    cond: WriteCondition | None = None
    etag: str | None = None
    live: Mapping[str, Any] | None = existing
    if existing.get("type") == "folder":
        if await list_folder_items(tm, existing["id"], limit=1):
            raise enotempty(dst.virtual)
    else:
        cond, live, etag = await held_file(accessor, dst, existing)
    if live is None:
        try:
            return await place(tm, item, new_name, folder_id)
        except BoxApiError as exc:
            raise (await retaken(exc, cond, dst)) or exc
    return await replace_item(
        accessor,
        dst,
        live,
        cond,
        etag,
        lambda: place(tm, item, new_name, folder_id),
        lambda landed: place(tm, landed, item["name"], _folder_of(item)),
    )


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
    item = await live_item_of(accessor, src, entry)
    if item is None:
        raise enoent(src.virtual)
    if src.virtual == dst.virtual:
        return None
    folder_id = parent_folder(accessor, dst, dst_parent)
    new_name = path_parts(dst)[-1]
    upto = lost_count()
    timer = start_op()
    existing = await live_item_of(accessor, dst, dst_entry)
    if existing is not None and existing["id"] != item["id"]:
        moved = await _replace_onto(accessor, item, dst, folder_id, existing)
    else:
        cond: WriteCondition | None = None
        if existing is None and item.get("type") == "file":
            cond = await replace_file(accessor, dst, None)
        try:
            moved = await place(tm, item, new_name, folder_id)
        except BoxApiError as exc:
            raise (await retaken(exc, cond, dst)) or exc
    # Only a folder has a subtree to drop, and only a positive "file"
    # rules one out. _replace refused a file onto a folder, so dst
    # held nothing below it unless the moved item is a folder.
    folder = item.get("type") != "file"
    op = "rename_prefix" if folder else "rename"
    record(op, src.virtual, "box", 0, timer)
    record(op, dst.virtual, "box", 0, timer)
    lift_lost(src, upto, subtree=folder)
    lift_lost(dst, upto, subtree=folder)
    return upload_stat(moved, stat_from_item, dst.virtual)
