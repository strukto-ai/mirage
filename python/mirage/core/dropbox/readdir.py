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

from functools import partial
from typing import Any

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import get_metadata, list_folder
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.constants import CONTENT_HASH
from mirage.core.dropbox.fingerprint import token_of
from mirage.errors.fs import listing_error
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import content_type_for_path


def stat_from_entry(entry: dict[str, Any]) -> FileStat:
    modified = (
        entry.get("server_modified") or entry.get("client_modified") or ""
    )
    name = entry.get("name", "")
    entry_id = entry.get("id") or entry.get("path_display") or name
    if entry.get(".tag") == "folder":
        return FileStat(
            name=name,
            type=FileType.DIRECTORY,
            modified=modified,
            extra={"dropbox_id": entry_id},
        )
    size = entry.get("size")
    return FileStat(
        name=name,
        size=size if isinstance(size, int) else None,
        type=FileType.FILE,
        content=content_type_for_path(name),
        modified=modified,
        fingerprint=token_of(entry.get(CONTENT_HASH)),
        extra={
            "dropbox_id": entry_id,
            "resource_type": "dropbox/file",
        },
    )


def dropbox_path_from_key(root: str, key: str) -> str:
    if not key:
        return root
    return f"{root}/{key}"


async def _metadata_or_none(
    accessor: DropboxAccessor, key: str
) -> dict[str, Any] | None:
    path = dropbox_path_from_key(accessor.root_path, key.strip("/"))
    try:
        return await get_metadata(accessor.token_manager, path)
    except DropboxApiError as exc:
        if exc.status == 409:
            return None
        raise


async def _is_file(accessor: DropboxAccessor, key: str) -> bool:
    entry = await _metadata_or_none(accessor, key)
    return entry is not None and entry.get(".tag") != "folder"


async def _is_dir(accessor: DropboxAccessor, key: str) -> bool:
    entry = await _metadata_or_none(accessor, key)
    return entry is not None and entry.get(".tag") == "folder"


async def readdir(
    accessor: DropboxAccessor, path_spec: PathSpec
) -> list[FileStat]:
    """A folder's children, each as ``stat`` answers it.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path_spec (PathSpec): the folder.
    """
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    dropbox_path = dropbox_path_from_key(accessor.root_path, key)
    try:
        files = await list_folder(accessor.token_manager, dropbox_path)
    except DropboxApiError as exc:
        # list_folder 409s on a missing path and on a file operand alike
        # (path/not_found, path/not_folder), and the subtag cannot tell
        # ENOENT from ENOTDIR either: a path under a file is not_found,
        # where opendir(2) reports Not a directory. So walk the ancestors
        # and let the walk pick the errno, at one request per component
        # on this failure path only.
        if exc.status == 409:
            raise await listing_error(
                path_spec.virtual,
                path,
                partial(_is_file, accessor),
                partial(_is_dir, accessor),
            ) from exc
        raise
    rows = [stat_from_entry(f) for f in files]
    rows.sort(key=lambda row: row.name)
    return rows
