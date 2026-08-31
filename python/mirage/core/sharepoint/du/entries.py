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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import du_tree_entries
from mirage.core.sharepoint.resolve import drive_loc, resolve
from mirage.core.sharepoint.stat import stat
from mirage.types import FileType, PathSpec


async def entries(
        accessor: SharePointAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX
) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total.

    Args:
        accessor (SharePointAccessor): SharePoint accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path, index=index)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return [], info.size or 0
    resolved = await resolve(accessor, path)
    if resolved.drive_id is None:
        return [], 0
    return await du_tree_entries(accessor.config,
                                 drive_loc(accessor.config, resolved,
                                           path.mount_path),
                                 session=accessor.pool)
