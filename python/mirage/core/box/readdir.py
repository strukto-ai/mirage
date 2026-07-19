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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.box.api import list_folder_items
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of

ROOT_FOLDER_ID = "0"

# File extensions that mirage post-processes into clean JSON. The vfs name
# gets a `.json` suffix appended so consumers (and the AI) see at a glance
# that cat returns JSON; the underlying Box file ID is the same regardless.
SPECIAL_EXT_TO_RT = {
    ".boxnote": "box/boxnote",
    ".boxcanvas": "box/boxcanvas",
    ".gdoc": "box/gdoc",
    ".gsheet": "box/gsheet",
    ".gslides": "box/gslides",
}


def special_resource_type(name: str) -> str | None:
    lower = name.lower()
    for src, rt in SPECIAL_EXT_TO_RT.items():
        if lower.endswith(src):
            return rt
    return None


def vfs_name_for(name: str) -> str:
    lower = name.lower()
    for src in SPECIAL_EXT_TO_RT:
        if lower.endswith(src):
            return name + ".json"
    return name


def resource_type_for(item: dict[str, Any]) -> str:
    if item.get("type") == "folder":
        return "box/folder"
    if item.get("type") == "web_link":
        return "box/weblink"
    special_rt = special_resource_type(item.get("name", ""))
    if special_rt is not None:
        return special_rt
    return "box/file"


def is_dir_name(child: str) -> bool | None:
    # Cold listings mark folders with a trailing slash; warm index-cache
    # entries are slash-less, so classification falls back to stat.
    return True if child.endswith("/") else None


async def readdir(
    accessor: BoxAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.resource_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries

    if not key:
        folder_id = accessor.config.root_folder_id or ROOT_FOLDER_ID
    else:
        result = await index.get(virtual_key)
        if result.entry is None:
            parent_virtual = virtual_key.rstrip("/").rsplit("/", 1)[0] or "/"
            if parent_virtual != virtual_key:
                parent_path = PathSpec.from_str_path(
                    parent_virtual, mount_key(parent_virtual, prefix))
                await readdir(accessor, parent_path, index)
                result = await index.get(virtual_key)
            if result.entry is None:
                raise enoent(virtual)
        if result.entry.resource_type != "box/folder":
            # Listing a file id would 404 on /folders/{id}/items; surface
            # the POSIX error so generic ls falls back to the file entry.
            raise NotADirectoryError(virtual)
        folder_id = result.entry.id

    items = await list_folder_items(accessor.token_manager, folder_id)
    entries: list[tuple[str, IndexEntry, bool]] = []
    for it in items:
        is_dir = it.get("type") == "folder"
        filename = vfs_name_for(it["name"])
        size = it.get("size")
        entry = IndexEntry(
            id=it["id"],
            name=filename,
            resource_type=resource_type_for(it),
            remote_time=it.get("modified_at") or "",
            vfs_name=filename,
            size=size if not is_dir and size else None,
        )
        entries.append((filename, entry, is_dir))

    await index.set_dir(virtual_key, [(name, e) for name, e, _ in entries])
    path_prefix = f"/{key}/" if key else "/"
    result_paths = []
    for name, _, is_folder in entries:
        if is_folder:
            result_paths.append(f"{prefix}{path_prefix}{name}/")
        else:
            result_paths.append(f"{prefix}{path_prefix}{name}")
    return result_paths
