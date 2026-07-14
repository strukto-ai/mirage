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
from mirage.cache.index import NULL_INDEX, IndexCacheStore, ResourceType
from mirage.core.onedrive._client import (GraphError, graph_get, item_url,
                                          split_path)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


def _entry_stat(item: dict) -> FileStat:
    name = item.get("name", "")
    if "folder" in item:
        return FileStat(name=name,
                        type=FileType.DIRECTORY,
                        size=item.get("size"),
                        modified=item.get("lastModifiedDateTime"))
    return FileStat(
        name=name,
        size=item.get("size"),
        modified=item.get("lastModifiedDateTime"),
        type=guess_type(name),
        fingerprint=item.get("cTag"),
        extra={
            "id": item.get("id"),
            "ctag": item.get("cTag"),
            "etag": item.get("eTag"),
        },
    )


async def stat(accessor: OneDriveAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    if not stripped:
        return FileStat(name="/", type=FileType.DIRECTORY)

    virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped)
    lookup = await index.get(virtual_key)
    if lookup.entry is not None:
        entry = lookup.entry
        if entry.resource_type == ResourceType.FOLDER:
            return FileStat(name=entry.name,
                            type=FileType.DIRECTORY,
                            size=entry.size,
                            modified=entry.remote_time or None)
        return FileStat(name=entry.name,
                        size=entry.size,
                        modified=entry.remote_time or None,
                        type=guess_type(entry.name))
    parent = virtual_key.rsplit("/", 1)[0] or "/"
    parent_listing = await index.list_dir(parent)
    if parent_listing.entries is not None:
        raise enoent(virtual)

    try:
        item = await graph_get(accessor.config,
                               item_url(accessor.config, "/" + stripped))
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    return _entry_stat(item)
