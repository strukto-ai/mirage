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
from typing import Any, cast

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import (
    get_file_info,
    get_folder_info,
    list_folder_items,
)
from mirage.core.box.client import BoxApiError
from mirage.core.box.constants import (
    ACTIVE,
    ALL_FILES_FOLDER_ID,
    SHA1,
    TRASH_FOLDER_ID,
)
from mirage.errors.fs import enoent, enotdir
from mirage.types import FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)


def path_parts(path: PathSpec) -> list[str]:
    return [p for p in path.vfs_path.strip("/").split("/") if p]


def root_id(accessor: BoxAccessor) -> str:
    return accessor.config.root_folder_id or ALL_FILES_FOLDER_ID


async def resolve_chain(
    accessor: BoxAccessor, parts: list[str]
) -> list[dict[str, Any]]:
    """Walk folder listings to resolve each component of a path.

    Box has no path-addressing endpoint, so ids are resolved by listing
    each level from the mount root. Returns the Box item for every
    component that resolved, in order; a missing component, or one below
    a non-folder, ends the chain early.

    Args:
        accessor (BoxAccessor): Box accessor.
        parts (list[str]): mount-relative path components.
    """
    tm = accessor.token_manager
    cur_id = root_id(accessor)
    chain: list[dict[str, Any]] = []
    for name in parts:
        if chain and chain[-1].get("type") != "folder":
            break
        children = await list_folder_items(tm, cur_id)
        match = next((c for c in children if c["name"] == name), None)
        if match is None:
            break
        chain.append(match)
        cur_id = match["id"]
    return chain


async def resolve_item(
    accessor: BoxAccessor, parts: list[str]
) -> dict[str, Any] | None:
    """Resolve a mount-relative path to its Box item.

    Returns None if any component is missing, or a non-final component
    is not a folder.

    Args:
        accessor (BoxAccessor): Box accessor.
        parts (list[str]): mount-relative path components.
    """
    chain = await resolve_chain(accessor, parts)
    if not parts or len(chain) < len(parts):
        return None
    return chain[-1]


def item_of(row: FileStat | None) -> dict[str, Any] | None:
    """The Box item a listed row names, in the shape a lookup answers.

    Args:
        row (FileStat | None): the row, as its folder's listing named it.
    """
    if row is None:
        return None
    return {
        "id": row.extra["box_id"],
        "type": "folder" if row.type is FileType.DIRECTORY else "file",
        "name": row.name,
        SHA1: row.extra.get(SHA1),
        "etag": row.extra.get("etag"),
    }


def parent_folder(
    accessor: BoxAccessor, path: PathSpec, parent: FileStat | None
) -> str:
    """The folder a create at ``path`` lands in: the mount root's, or
    what is at the parent path.

    A missing or non-directory parent names the operand, as mkdir(2)
    does.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path being created.
        parent (FileStat | None): what is at its parent path.
    """
    if len(path_parts(path)) <= 1:
        return root_id(accessor)
    if parent is None:
        raise enoent(path.virtual)
    if parent.type is not FileType.DIRECTORY:
        raise enotdir(path.virtual)
    return cast(str, parent.extra["box_id"])


def mount_relative_key(
    item: dict[str, Any], root_folder_id: str
) -> str | None:
    """Mount-relative path of an item, from its ``path_collection``.

    Box lists an item's ancestors from the account root down to its
    immediate parent, excluding the item itself; everything up to and
    including the mount root folder is trimmed. None when the mount root
    is not among the ancestors, which is every item outside the mount.

    Args:
        item (dict[str, Any]): A Box item carrying ``path_collection``.
        root_folder_id (str): Box id of the mount root folder.
    """
    entries = (item.get("path_collection") or {}).get("entries") or []
    names: list[str] = []
    collecting = False
    for anc in entries:
        if collecting:
            names.append(anc.get("name", ""))
        if anc.get("id") == root_folder_id:
            collecting = True
    if not collecting:
        return None
    names.append(item.get("name", ""))
    return "/".join(n for n in names if n)


def names_this_path(
    accessor: BoxAccessor, item: dict[str, Any], path: PathSpec
) -> bool:
    """Whether a live ``GET /files/{id}`` or ``GET /folders/{id}`` answer is
    the active item at ``path``.

    Box enforces unique names per folder, so an item whose live chain of names
    from the mount root equals the path is the very item walking the path
    would reach. Four checks: the item is a file or folder, its ``item_status`` is
    active, its ``path_collection`` starts at All Files and passes no Trash
    folder, and its names below the mount root equal the path. The name
    comparison alone already rejects a trashed chain below the mount root;
    the All Files check also refuses a chain that does not start at All
    Files yet passes through the mount root with the right names below it,
    which the name comparison alone would accept, and with the Trash check
    catches the mount root itself in Trash.

    Args:
        accessor (BoxAccessor): Box accessor.
        item (dict[str, Any]): ``GET /files/{id}`` answer.
        path (PathSpec): the path being checked.
    """
    if item.get("type") not in ("file", "folder"):
        return False
    if item.get("item_status") != ACTIVE:
        return False
    chain = (item.get("path_collection") or {}).get("entries") or []
    if not chain or chain[0].get("id") != ALL_FILES_FOLDER_ID:
        return False
    if any(anc.get("id") == TRASH_FOLDER_ID for anc in chain):
        return False
    key = mount_relative_key(item, root_id(accessor))
    return key == "/".join(path_parts(path))


async def live_item_of(
    accessor: BoxAccessor, path: PathSpec, row: FileStat | None
) -> dict[str, Any] | None:
    """The item a listed row names, as :func:`live_item` finds it at
    ``path`` now; None for no row.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path about to change.
        row (FileStat | None): what its folder's listing named there.
    """
    item = item_of(row)
    return None if item is None else await live_item(accessor, path, item)


async def live_item(
    accessor: BoxAccessor, path: PathSpec, lead: dict[str, Any] | None
) -> dict[str, Any] | None:
    """What is at ``path`` now, asked live.

    A listed row can be older than the path's item: another client may
    have moved, renamed or trashed it, and a change made by its id would
    land at another path. So a check and every change ask again: one
    ``GET /files/{id}`` or ``GET /folders/{id}`` by the id the row names,
    when the answer is still the active item at exactly this path, else a
    walk of the listings from the mount root. Only the walk may call a
    path gone, so a 404 or 403 by id falls back to it rather than
    answering None.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the path.
        lead (dict[str, Any] | None): the item the listed row names.
    """
    if lead is not None and lead.get("id"):
        info = (
            get_folder_info if lead.get("type") == "folder" else get_file_info
        )
        try:
            item = await info(accessor.token_manager, lead["id"])
        except BoxApiError as exc:
            if exc.status not in (403, 404):
                raise
            logger.debug("listed id for %s unusable: %s", path.virtual, exc)
        else:
            if names_this_path(accessor, item, path):
                return item
    return await resolve_item(accessor, path_parts(path))
