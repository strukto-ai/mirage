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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry, ResourceType
from mirage.core.onedrive._client import GraphError, graph_list, item_url
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of


async def readdir(accessor: OneDriveAccessor, path: PathSpec,
                  index: IndexCacheStore) -> list[str]:
    original = path
    prefix = mount_prefix_of(path.virtual, path.resource_path) or ""
    raw = path.directory if path.pattern else path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    stripped = raw.strip("/")
    virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped) \
        if stripped else (prefix or "/")
    listing = await index.list_dir(virtual_key)
    if listing.entries is not None:
        return listing.entries

    url = item_url(accessor.config,
                   "/" + stripped if stripped else "/",
                   action="/children")
    try:
        children = await graph_list(accessor.config, url)
    except GraphError as exc:
        if exc.status != 404:
            raise
        info = await stat(accessor, original)
        if info.type != FileType.DIRECTORY:
            raise NotADirectoryError(virtual_key) from exc
        raise enoent(virtual_key) from exc
    base = "/" + stripped if stripped else ""
    names: list[str] = []
    index_entries: list[tuple[str, IndexEntry]] = []
    for child in children:
        cname = child.get("name", "")
        key = f"{base}/{cname}"
        names.append(key)
        if "folder" in child:
            entry = IndexEntry(id=key,
                               name=cname,
                               resource_type=ResourceType.FOLDER,
                               size=child.get("size"),
                               remote_time=child.get("lastModifiedDateTime",
                                                     ""))
        else:
            entry = IndexEntry(id=key,
                               name=cname,
                               resource_type=ResourceType.FILE,
                               size=child.get("size"),
                               remote_time=child.get("lastModifiedDateTime",
                                                     ""))
        index_entries.append((cname, entry))
    names = sorted(names)
    virtual_entries = sorted((prefix + e if prefix else e) for e in names)
    await index.set_dir(virtual_key, index_entries)
    return virtual_entries
