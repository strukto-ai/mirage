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

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import active_cache_manager
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.cache.index.warm import entry_or_warm
from mirage.core.box.api import absent_on_404, list_folder_items
from mirage.core.box.constants import SHA1
from mirage.core.box.fingerprint import token_of
from mirage.core.box.resolve import root_id
from mirage.errors.fs import enoent, enotdir
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def resource_type_for(item: dict[str, Any]) -> str:
    if item.get("type") == "folder":
        return "box/folder"
    if item.get("type") == "web_link":
        return "box/weblink"
    return "box/file"


async def readdir(
    accessor: BoxAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    virtual = path_spec.virtual
    prefix = mount_prefix_of(path_spec.virtual, path_spec.vfs_path)
    path = (path_spec.dir if path_spec.pattern else path_spec).mount_path
    key = path.strip("/")
    virtual_key = prefix + "/" + key if key else prefix or "/"

    cached = await index.list_dir(virtual_key)
    if cached.entries is not None:
        return cached.entries

    if not key:
        folder_id = root_id(accessor)
    else:
        manager = active_cache_manager()
        probed = (
            manager.probed_stat(path_spec) if manager is not None else None
        )
        if probed is not None and probed.type != FileType.DIRECTORY:
            raise enotdir(virtual)
        parent_virtual = virtual_key.rstrip("/").rsplit("/", 1)[0] or "/"
        parent_path = PathSpec.from_str_path(
            parent_virtual, mount_key(parent_virtual, prefix)
        )
        entry = await entry_or_warm(
            index, virtual_key, partial(readdir, accessor, parent_path, index)
        )
        if entry is None:
            raise enoent(virtual)
        if entry.resource_type != "box/folder":
            raise enotdir(virtual)
        folder_id = entry.id

    items = await absent_on_404(
        virtual, lambda: list_folder_items(accessor.token_manager, folder_id)
    )
    entries: list[tuple[str, IndexEntry, bool]] = []
    for it in items:
        if it.get("type") == "web_link":
            # Weblinks are bookmarks: no content endpoint, no size. Hide
            # them from listings instead of serving an unreadable entry.
            continue
        is_dir = it.get("type") == "folder"
        filename = it["name"]
        sha1 = token_of(it.get(SHA1))
        entry = IndexEntry(
            id=it["id"],
            name=filename,
            resource_type=resource_type_for(it),
            remote_time=it.get("modified_at") or "",
            vfs_name=filename,
            size=None if is_dir else it.get("size"),
            extra={SHA1: sha1} if sha1 else {},
        )
        entries.append((filename, entry, is_dir))

    entries.sort(key=lambda listed: listed[0])
    await index.set_dir(virtual_key, [(name, e) for name, e, _ in entries])
    path_prefix = f"/{key}/" if key else "/"
    result_paths = []
    for name, _, is_folder in entries:
        if is_folder:
            result_paths.append(f"{prefix}{path_prefix}{name}/")
        else:
            result_paths.append(f"{prefix}{path_prefix}{name}")
    return result_paths
