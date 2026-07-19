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
from mirage.core.box.readdir import ROOT_FOLDER_ID, vfs_name_for
from mirage.types import PathSpec


def path_parts(path: PathSpec) -> list[str]:
    return [p for p in path.resource_path.strip("/").split("/") if p]


def root_id(accessor: BoxAccessor) -> str:
    return accessor.config.root_folder_id or ROOT_FOLDER_ID


async def resolve_item(accessor: BoxAccessor,
                       parts: list[str]) -> dict[str, Any] | None:
    """Walk folder listings to resolve a mount-relative path to its item.

    Box has no path-addressing endpoint, so writes resolve ids by listing
    each level from the mount root. Returns the Box item dict for the full
    path, or None if any component is missing (or a non-final component is
    not a folder). Matches vfs names so paths spelled with the ``.json``
    suffix on box-native files still resolve.

    Args:
        accessor (BoxAccessor): Box accessor.
        parts (list[str]): mount-relative path components.
    """
    tm = accessor.token_manager
    cur_id = root_id(accessor)
    cur: dict[str, Any] | None = None
    for i, name in enumerate(parts):
        children = await list_folder_items(tm, cur_id)
        match = next((c for c in children if vfs_name_for(c["name"]) == name),
                     None)
        if match is None:
            return None
        cur = match
        if i < len(parts) - 1:
            if match.get("type") != "folder":
                return None
            cur_id = match["id"]
    return cur


async def resolve_parent_id(accessor: BoxAccessor,
                            parts: list[str]) -> str | None:
    if len(parts) <= 1:
        return root_id(accessor)
    parent = await resolve_item(accessor, parts[:-1])
    if parent is None or parent.get("type") != "folder":
        return None
    return parent["id"]
