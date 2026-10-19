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

import functools
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, ParamSpec, TypeVar

import aiohttp

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT
from mirage.errors.fs import eacces, enoent, enotdir
from mirage.types import FileStat, FileType, PathSpec

P = ParamSpec("P")
T = TypeVar("T")


def eacces_on_denied(
    fn: Callable[P, Awaitable[T]],
) -> Callable[P, Awaitable[T]]:
    """Map a Drive HTTP 403 during a mutation to EACCES.

    Drive access is per-item (shared-drive roles, folder-level grants),
    so a write-mode mount can still hold items the user may not edit.
    A denied mutation surfaces as Permission denied on the operand,
    like a real filesystem, instead of a raw HTTP error.
    """

    @functools.wraps(fn)
    async def wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
        try:
            return await fn(*args, **kwargs)
        except aiohttp.ClientResponseError as exc:
            if exc.status == 403:
                spec = next((a for a in args if isinstance(a, PathSpec)), None)
                raise eacces(spec.virtual if spec is not None else "") from exc
            raise

    return wrapper


async def root_context(accessor: GDriveAccessor) -> tuple[str, str | None]:
    """The mount root's (folder id, shared drive id).

    An unscoped mount roots at My Drive. A ``folder_id`` scope may point
    inside a Shared Drive (or be a Shared Drive id itself); its ``driveId``
    is fetched once via ``files.get`` and memoized on the accessor, so every
    listing and resolution under the root queries the right corpus.

    Args:
        accessor (GDriveAccessor): backend accessor.

    Returns:
        tuple[str, str | None]: (root folder id, shared drive id or None).
    """
    folder_id = accessor.token_manager.config.folder_id
    if not folder_id:
        return "root", None
    if not hasattr(accessor, "root_drive_id"):
        item = await accessor.drive.get_file(folder_id)
        accessor.root_drive_id = item.get("driveId")
    return folder_id, accessor.root_drive_id


@dataclass(frozen=True, slots=True)
class DriveNode:
    """A resolved Drive item: enough identity to mutate it."""

    id: str
    name: str
    mime_type: str
    drive_id: str | None = None

    @property
    def is_folder(self) -> bool:
        return self.mime_type == FOLDER_MIME


def drive_target_name(basename: str, mime_type: str) -> str:
    """Destination Drive name for moving/copying an item to a vfs basename.

    A google-native file's vfs basename carries the rendered suffix
    (``Report.gdoc.json``); its Drive name does not, so the suffix matching
    the item's MIME type is stripped.

    Args:
        basename (str): destination vfs basename.
        mime_type (str): the item's MIME type.
    """
    ext = MIME_TO_EXT.get(mime_type)
    if ext and basename.endswith(ext) and len(basename) > len(ext):
        return basename[: -len(ext)]
    return basename


def node_from_item(item: dict[str, Any], drive_id: str | None) -> DriveNode:
    return DriveNode(
        id=item["id"],
        name=item["name"],
        mime_type=item.get("mimeType", ""),
        drive_id=item.get("driveId") or drive_id,
    )


def node_of(row: FileStat) -> DriveNode:
    """The Drive item a listed row names.

    Args:
        row (FileStat): the row, as the folder's listing named it.
    """
    return DriveNode(
        id=row.extra["file_id"],
        name=row.name,
        mime_type=row.extra.get("mime_type", ""),
        drive_id=row.extra.get("drive_id"),
    )


async def parent_folder(
    accessor: GDriveAccessor, path: PathSpec, parent: FileStat | None
) -> tuple[str, str | None]:
    """The folder a create at ``path`` lands in: the mount root's, or
    what is at the parent path.

    A missing or non-directory parent names the operand, as mkdir(2)
    does.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): the path being created.
        parent (FileStat | None): what is at its parent path.

    Returns:
        tuple[str, str | None]: (parent folder id, shared drive id or None).
    """
    if "/" not in path.vfs_path.strip("/"):
        return await root_context(accessor)
    if parent is None:
        raise enoent(path.virtual)
    if parent.type is not FileType.DIRECTORY:
        raise enotdir(path.virtual)
    return parent.extra["file_id"], parent.extra.get("drive_id")
