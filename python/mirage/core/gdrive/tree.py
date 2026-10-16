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
from collections.abc import AsyncIterator
from typing import Any

import aiohttp

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.readdir import readdir, stat_from_item
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT, list_children
from mirage.types import DirListing, FileStat, FileType, PathSpec

logger = logging.getLogger(__name__)

PARENTS_PER_QUERY = 40


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
    folder_id: str,
    drive_id: str | None,
) -> AsyncIterator[tuple[str, dict[str, Any], bool]]:
    """Walk a folder subtree, yielding (mount-relative path, item, is_dir).

    The walk goes a level at a time, the level's folders listed together
    (``list_level``). Children are visited in vfs-name order so every
    traversal-based command (find, du) is deterministic, mirroring the
    msgraph iter_tree contract.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): directory to walk (mount-relative root allowed).
        folder_id (str): the directory's folder id.
        drive_id (str | None): its shared drive, if any.
    """
    level: list[tuple[str, str, str | None]] = [
        (path.vfs_path, folder_id, drive_id)
    ]
    while level:
        children = await list_level(
            accessor, [(fid, did) for _, fid, did in level]
        )
        below: list[tuple[str, str, str | None]] = []
        for rel, fid, did in level:
            for item in sorted(children[fid], key=vfs_name):
                name = vfs_name(item)
                child_rel = f"{rel}/{name}" if rel else name
                is_dir = item.get("mimeType") == FOLDER_MIME
                yield child_rel, item, is_dir
                if is_dir:
                    below.append(
                        (
                            child_rel,
                            str(item["id"]),
                            item.get("driveId") or did,
                        )
                    )
        level = below


async def list_level(
    accessor: GDriveAccessor, folders: list[tuple[str, str | None]]
) -> dict[str, list[dict[str, Any]]]:
    """The children of each folder of one level of a walk, by folder id.

    One query asks for the children of up to ``PARENTS_PER_QUERY``
    folders of one corpus, where a walk lists each folder on its own, and
    each child is filed under every folder asked about that its
    ``parents`` name. A folder asked about alone takes every child, so
    ``root``, the alias Drive names My Drive by, lists too.

    Args:
        accessor (GDriveAccessor): backend accessor.
        folders (list[tuple[str, str | None]]): each folder's id and its
            shared drive.
    """
    corpora: dict[str | None, list[str]] = {}
    children: dict[str, list[dict[str, Any]]] = {}
    for folder_id, drive_id in folders:
        corpora.setdefault(drive_id, []).append(folder_id)
        children[folder_id] = []
    for drive_id, ids in corpora.items():
        for start in range(0, len(ids), PARENTS_PER_QUERY):
            asked = ids[start : start + PARENTS_PER_QUERY]
            for item in await list_children(
                accessor.token_manager, asked, drive_id
            ):
                filed = (
                    asked
                    if len(asked) == 1
                    else [p for p in item.get("parents") or [] if p in asked]
                )
                for parent in filed:
                    children[parent].append(item)
    return children


async def tree(
    accessor: GDriveAccessor, path: PathSpec, entry: FileStat | None = None
) -> dict[str, FileStat] | None:
    """Every item under a folder, each as its folder's listing renders it,
    read a level at a time (``list_level``): a query per level and corpus
    where a walk sends a listing per folder.

    The folder's own children are its listing, so the mount root keeps
    its Shared Drives and a folder that is not there raises what a
    listing raises. Of two items with one name in a folder, the one its
    listing keeps, the last, stands. None when that listing is short
    (Shared Drives it could not list), or when a level below it fails, so
    the walk lists what is there and reports, or skips, each folder on
    its own.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the directory.
        entry (FileStat | None): what is at the directory.
    """
    listed = await readdir(accessor, path, entry)
    if isinstance(listed, DirListing):
        return None
    found: dict[str, FileStat] = {}
    level = _placed(found, "", listed, None)
    while level:
        try:
            children = await list_level(accessor, list(level.values()))
        except (OSError, aiohttp.ClientError) as exc:
            logger.debug(
                "drive tree of %s left to the walk: %s", path.virtual, exc
            )
            return None
        below: dict[str, tuple[str, str | None]] = {}
        for rel, (folder_id, drive_id) in level.items():
            rows = sorted(
                map(stat_from_item, children[folder_id]),
                key=lambda row: row.name,
            )
            below.update(_placed(found, rel, rows, drive_id))
        level = below
    return found


def _placed(
    found: dict[str, FileStat],
    rel: str,
    rows: list[FileStat],
    drive_id: str | None,
) -> dict[str, tuple[str, str | None]]:
    """Put a folder's rows into a tree read, and answer the folders among
    them by path, each with its id and shared drive.

    Args:
        found (dict[str, FileStat]): the tree read so far.
        rel (str): the folder's path below the read's top, "" for the top.
        rows (list[FileStat]): the folder's rows, in listing order.
        drive_id (str | None): the folder's shared drive.
    """
    folders: dict[str, tuple[str, str | None]] = {}
    for row in rows:
        key = f"{rel}/{row.name}" if rel else row.name
        found[key] = row
        folders.pop(key, None)
        if row.type is FileType.DIRECTORY:
            folders[key] = (
                str(row.extra["file_id"]),
                row.extra.get("drive_id") or drive_id,
            )
    return folders
