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

from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import list_folder_items
from mirage.core.box.constants import (
    ACTIVE,
    ALL_FILES_FOLDER_ID,
    TRASH_FOLDER_ID,
)
from mirage.types import PathSpec


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


async def resolve_parent_id(
    accessor: BoxAccessor, parts: list[str]
) -> str | None:
    if len(parts) <= 1:
        return root_id(accessor)
    parent = await resolve_item(accessor, parts[:-1])
    if parent is None or parent.get("type") != "folder":
        return None
    return parent["id"]


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
    """Whether a live ``GET /files/{id}`` answer is the active file at ``path``.

    Box enforces unique names per folder, so a file whose live chain of names
    from the mount root equals the path is the very item walking the path
    would reach. Four checks: the item is a file, its ``item_status`` is
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
    if item.get("type") != "file" or item.get("item_status") != ACTIVE:
        return False
    chain = (item.get("path_collection") or {}).get("entries") or []
    if not chain or chain[0].get("id") != ALL_FILES_FOLDER_ID:
        return False
    if any(anc.get("id") == TRASH_FOLDER_ID for anc in chain):
        return False
    key = mount_relative_key(item, root_id(accessor))
    return key == "/".join(path_parts(path))
