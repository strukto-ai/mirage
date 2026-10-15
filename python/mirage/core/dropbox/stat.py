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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.api import list_folder, lookup
from mirage.core.dropbox.client import DropboxApiError
from mirage.core.dropbox.paths import dropbox_path_of, spelled_otherwise
from mirage.core.dropbox.readdir import dropbox_path_from_key, stat_from_entry
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec


async def _stat_from_api(
    accessor: DropboxAccessor, path: PathSpec
) -> FileStat:
    # One get_metadata, which matches names case-insensitively where a
    # listing is exact.
    entry = await lookup(
        accessor.token_manager, dropbox_path_of(accessor, path)
    )
    if entry is None or spelled_otherwise(path, entry):
        raise enoent(path.virtual)
    return stat_from_entry(entry)


async def stat(accessor: DropboxAccessor, path: PathSpec) -> FileStat:
    """What is at ``path``, asked by its Dropbox path.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): the path.
    """
    if not path.vfs_path.strip("/"):
        return FileStat(name="/", type=FileType.DIRECTORY)
    return await _stat_from_api(accessor, path)


async def tree(
    accessor: DropboxAccessor, path: PathSpec
) -> dict[str, FileStat] | None:
    """Every entry under a folder from one recursive ``list_folder``,
    each as ``stat`` answers it from a listing.

    Dropbox matches paths without case, so each entry's place comes from
    its lowercased path and its name from the entry, as a listing of its
    folder names it. A folder Dropbox refuses to list (a missing path, a
    file) answers None, so the walk's readdir reports it.

    Args:
        accessor (DropboxAccessor): backend handle.
        path (PathSpec): the folder.
    """
    folder = dropbox_path_from_key(
        accessor.root_path, path.mount_path.strip("/")
    )
    try:
        entries = await list_folder(
            accessor.token_manager, folder, recursive=True
        )
    except DropboxApiError as exc:
        if exc.status == 409:
            return None
        raise
    base = folder.lower().rstrip("/")
    places: dict[str, str] = {base: ""}
    found: dict[str, FileStat] = {}
    for entry in sorted(
        entries, key=lambda e: str(e.get("path_lower", "")).count("/")
    ):
        lower = str(entry.get("path_lower", ""))
        parent, _, _ = lower.rpartition("/")
        if lower == base or parent not in places:
            continue
        above = places[parent]
        rel = f"{above}/{entry['name']}" if above else str(entry["name"])
        places[lower] = rel
        found[rel] = stat_from_entry(entry)
    return found
