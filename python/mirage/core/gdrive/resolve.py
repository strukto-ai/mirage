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
import logging
import posixpath
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, ParamSpec, TypeVar

import aiohttp

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.google._client import TokenManager
from mirage.core.google.drive import (FOLDER_MIME, MIME_TO_EXT, get_file,
                                      list_files, list_shared_drives)
from mirage.types import PathSpec
from mirage.utils.errors import enoent

logger = logging.getLogger(__name__)

SUFFIX_TO_MIME = {ext: mime for mime, ext in MIME_TO_EXT.items()}

P = ParamSpec("P")
T = TypeVar("T")


def eacces_on_denied(
        fn: Callable[P, Awaitable[T]]) -> Callable[P, Awaitable[T]]:
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
                raise PermissionError(
                    spec.virtual if spec is not None else "") from exc
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
    token_manager = accessor.token_manager
    folder_id = token_manager.config.folder_id
    if not folder_id:
        return "root", None
    if not hasattr(accessor, "root_drive_id"):
        item = await get_file(token_manager, folder_id)
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

    @property
    def is_native(self) -> bool:
        return self.mime_type in SUFFIX_TO_MIME.values()


# Mutations resolve paths with direct Drive queries instead of the read-side
# index: Drive is id-addressed and allows duplicate sibling names, so GNU
# check-then-act semantics (EEXIST, replace-on-rename) need the server's
# current state, not a possibly stale cache.
def query_candidates(segment: str) -> list[tuple[str, str | None]]:
    """Drive-name candidates for one vfs path segment.

    A google-native file renders as ``<name><suffix>`` (e.g.
    ``Report.gdoc.json``), so a suffixed segment is looked up both as a
    literal name and as the stripped native document.

    Args:
        segment (str): vfs path segment.

    Returns:
        list[tuple[str, str | None]]: (drive name, mime filter) candidates,
            tried in order.
    """
    candidates: list[tuple[str, str | None]] = [(segment, None)]
    for ext, mime in SUFFIX_TO_MIME.items():
        if segment.endswith(ext) and len(segment) > len(ext):
            candidates.append((segment[:-len(ext)], mime))
    return candidates


def drive_target_name(basename: str, node: DriveNode) -> str:
    """Destination Drive name for moving/copying a node to a vfs basename.

    A google-native file's vfs basename carries the rendered suffix
    (``Report.gdoc.json``); its Drive name does not, so the suffix matching
    the node's MIME type is stripped.

    Args:
        basename (str): destination vfs basename.
        node (DriveNode): source node being moved or copied.
    """
    ext = MIME_TO_EXT.get(node.mime_type)
    if ext and basename.endswith(ext) and len(basename) > len(ext):
        return basename[:-len(ext)]
    return basename


def node_from_item(item: dict[str, Any], drive_id: str | None) -> DriveNode:
    return DriveNode(
        id=item["id"],
        name=item["name"],
        mime_type=item.get("mimeType", ""),
        drive_id=item.get("driveId") or drive_id,
    )


async def resolve_segment(
    token_manager: TokenManager,
    parent_id: str,
    segment: str,
    drive_id: str | None,
    at_root: bool,
) -> DriveNode | None:
    """Resolve one path segment inside a parent folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        parent_id (str): parent folder ID.
        segment (str): vfs path segment.
        drive_id (str | None): shared drive scope, if any.
        at_root (bool): whether the segment sits at the mount root, where a
            shared drive name is also a valid directory.
    """
    for name, mime in query_candidates(segment):
        matches = await list_files(token_manager,
                                   folder_id=parent_id,
                                   drive_id=drive_id,
                                   name=name,
                                   mime_type=mime)
        if matches:
            return node_from_item(matches[0], drive_id)
    if at_root:
        # Shared Drive enumeration is best-effort, mirroring readdir: a
        # missing scope must not break resolution of My Drive paths.
        try:
            shared = await list_shared_drives(token_manager)
        except Exception:
            logger.debug("Unable to list Google Shared Drives", exc_info=True)
            shared = []
        for d in shared:
            if d.get("name") == segment:
                return DriveNode(id=d["id"],
                                 name=segment,
                                 mime_type=FOLDER_MIME,
                                 drive_id=d["id"])
    return None


async def resolve_key(accessor: GDriveAccessor, key: str) -> DriveNode | None:
    """Resolve a mount-relative key to its Drive item, or None.

    Args:
        accessor (GDriveAccessor): backend accessor.
        key (str): mount-relative path ("a/b/c"); "" is the mount root.
    """
    token_manager = accessor.token_manager
    parent_id, drive_id = await root_context(accessor)
    node: DriveNode | None = None
    segments = [s for s in key.split("/") if s]
    for i, segment in enumerate(segments):
        # Shared drive names are only directories at the real Drive root,
        # never inside a folder-scoped mount.
        node = await resolve_segment(token_manager,
                                     parent_id,
                                     segment,
                                     drive_id,
                                     at_root=i == 0 and parent_id == "root")
        if node is None:
            return None
        if i < len(segments) - 1:
            if not node.is_folder:
                raise NotADirectoryError("/" + "/".join(segments[:i + 1]))
            parent_id = node.id
            drive_id = node.drive_id
    return node


async def resolve_dir(accessor: GDriveAccessor, key: str,
                      virtual: str) -> tuple[str, str | None]:
    """Resolve a mount-relative key that must be a directory.

    Args:
        accessor (GDriveAccessor): backend accessor.
        key (str): mount-relative path; "" is the mount root.
        virtual (str): full virtual path, for error messages.

    Returns:
        tuple[str, str | None]: (folder id, shared drive id or None).
    """
    if not key:
        return await root_context(accessor)
    node = await resolve_key(accessor, key)
    if node is None:
        raise enoent(virtual)
    if not node.is_folder:
        raise NotADirectoryError(virtual)
    return node.id, node.drive_id


async def resolve_parent(accessor: GDriveAccessor,
                         path: PathSpec) -> tuple[str, str | None]:
    """Resolve the parent directory of a path for a create-style op.

    Args:
        accessor (GDriveAccessor): backend accessor.
        path (PathSpec): target path whose parent must exist.

    Returns:
        tuple[str, str | None]: (parent folder id, shared drive id or None).
    """
    key = path.resource_path
    parent_key = posixpath.dirname(key)
    parent_virtual = posixpath.dirname(path.virtual.rstrip("/")) or "/"
    return await resolve_dir(accessor, parent_key, parent_virtual)
