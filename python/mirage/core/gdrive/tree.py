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

from collections.abc import AsyncIterator
from typing import Any

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.resolve import resolve_dir
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT, list_files
from mirage.types import PathSpec


def vfs_name(item: dict[str, Any]) -> str:
    """The rendered vfs filename for a Drive item.

    Args:
        item (dict): Drive file resource.
    """
    ext = MIME_TO_EXT.get(item.get("mimeType", ""))
    name = str(item["name"])
    return f"{name}{ext}" if ext else name


async def iter_tree(
    accessor: GDriveAccessor,
    path: PathSpec,
) -> AsyncIterator[tuple[str, dict[str, Any], bool]]:
    """Walk a folder subtree, yielding (mount-relative path, item, is_dir).

    Children are visited in vfs-name order so every traversal-based
    command (find, du) is deterministic, mirroring the msgraph iter_tree
    contract.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): directory to walk (mount-relative root allowed).
    """
    base = path.resource_path
    folder_id, drive_id = await resolve_dir(accessor, base, path.virtual)
    stack: list[tuple[str, str, str | None]] = [(base, folder_id, drive_id)]
    while stack:
        rel, fid, did = stack.pop(0)
        children = await list_files(accessor.token_manager,
                                    folder_id=fid,
                                    drive_id=did)
        children.sort(key=vfs_name)
        for item in children:
            name = vfs_name(item)
            child_rel = f"{rel}/{name}" if rel else name
            is_dir = item.get("mimeType") == FOLDER_MIME
            yield child_rel, item, is_dir
            if is_dir:
                stack.append((child_rel, str(item["id"]), item.get("driveId")
                              or did))
