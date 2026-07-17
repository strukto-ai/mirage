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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import readdir_items
from mirage.core.onedrive._client import drive_loc
from mirage.core.onedrive.stat import stat
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_prefix_of


async def readdir(accessor: OneDriveAccessor,
                  path: PathSpec,
                  index: IndexCacheStore = NULL_INDEX) -> list[str]:
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
    return await readdir_items(accessor.config,
                               drive_loc(accessor.config, stripped), index,
                               prefix, stripped, virtual_key,
                               partial(stat, accessor, original, index))
