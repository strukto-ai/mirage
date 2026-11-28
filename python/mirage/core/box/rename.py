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
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from mirage.accessor.box import BoxAccessor
from mirage.cache.types import WriteCondition
from mirage.core.box.api import (
    update_file,
    update_folder,
)
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.core.box.copy import (
    clear_file,
    held_file,
    replace_file,
    retaken,
)
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import live_item_of, parent_folder, path_parts
from mirage.core.box.rmdir import delete_empty_folder
from mirage.errors.fs import eisdir, enoent, enotdir
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import FileStat, PathSpec
from mirage.utils.upload import upload_stat

logger = logging.getLogger(__name__)


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


async def _place(
    tm: BoxTokenManager,
    item: Mapping[str, Any],
    name: str,
    folder_id: str | None,
) -> dict[str, Any]:
    """Give ``item`` a name, and a folder unless ``folder_id`` is None.

    Args:
        tm (BoxTokenManager): token manager.
        item (dict[str, Any]): the file or folder.
        name (str): its new name.
        folder_id (str | None): the folder it moves into.
    """
    if item.get("type") == "folder":
        return await update_folder(
            tm, item["id"], name=name, parent_id=folder_id
        )
    return await update_file(tm, item["id"], name=name, parent_id=folder_id)


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

    A stale destination file is refused before anything is sent. Box
    refuses a taken name, so the item lands beside it under a staged name
    first, what it replaces goes next (a file held to the version read,
    only an empty folder, which recursive=false gets from Box for free, as
    rmdir does), and the item takes the name last: a refused move leaves
    both as they were, and a refused delete or rename puts the item back
    where it was.

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
    folder = existing.get("type") == "folder"
    cond: WriteCondition | None = None
    etag: str | None = None
    live: Mapping[str, Any] | None = existing
    if not folder:
        cond, live, etag = await held_file(accessor, dst, existing)
    name = new_name if live is None else f"{new_name}.mirage-{uuid4().hex}"
    try:
        landed = await _place(tm, item, name, folder_id)
    except BoxApiError as exc:
        raise (await retaken(exc, cond, dst)) or exc
    if live is None:
        return landed
    try:
        if folder:
            await delete_empty_folder(tm, live["id"], dst)
        else:
            await clear_file(accessor, dst, live, cond, etag)
        return await _place(tm, landed, new_name, None)
    except Exception as exc:
        try:
            await _place(tm, landed, item["name"], _folder_of(item))
        except Exception as undo:
            logger.debug("could not move %s back: %s", item["name"], undo)
        if isinstance(exc, BoxApiError):
            raise (await retaken(exc, cond, dst)) or exc
        raise


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
            moved = await _place(tm, item, new_name, folder_id)
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
