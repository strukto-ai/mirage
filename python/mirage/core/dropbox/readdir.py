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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import list_folder
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


def is_dir_name(child: str) -> bool | None:
    # Cold reads mark folders with a trailing slash; warm index-cache hits
    # return slash-less keys, so classification falls back to stat.
    return True if child.endswith("/") else None


def _resource_type(entry: dict[str, Any]) -> str:
    if entry.get(".tag") == "folder":
        return "dropbox/folder"
    return "dropbox/file"


def dropbox_path_from_key(root: str, key: str) -> str:
    if not key:
        return root
    return f"{root}/{key}"


async def readdir(
    accessor: DropboxAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries

    dropbox_path = dropbox_path_from_key(accessor.root_path, key)
    try:
        files = await list_folder(accessor.token_manager, dropbox_path)
    except DropboxApiError as exc:
        # list_folder 409s on missing paths and on file operands
        # (path/not_found, path/not_folder); both map to ENOENT so ls
        # falls back to its stat-the-operand path like other backends.
        if exc.status == 409:
            raise enoent(path_spec.virtual) from exc
        raise

    entries: list[tuple[str, IndexEntry, bool]] = []
    for f in files:
        is_dir = f.get(".tag") == "folder"
        filename = f["name"]
        modified = f.get("server_modified") or f.get("client_modified") or ""
        size = f.get("size")
        entry = IndexEntry(
            id=f.get("id") or f.get("path_display") or filename,
            name=filename,
            resource_type=_resource_type(f),
            remote_time=modified,
            vfs_name=filename,
            size=size
            if not is_dir and isinstance(size, int) and size > 0 else None,
        )
        entries.append((filename, entry, is_dir))

    await index.set_dir(virtual_key, [(name, e) for name, e, _ in entries])
    path_prefix = f"/{key}/" if key else "/"
    out: list[str] = []
    for name, _, is_folder in entries:
        if is_folder:
            out.append(f"{prefix}{path_prefix}{name}/")
        else:
            out.append(f"{prefix}{path_prefix}{name}")
    return out
