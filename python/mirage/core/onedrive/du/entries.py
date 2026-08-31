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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import du_tree_entries
from mirage.core.onedrive.client import drive_loc, split_path
from mirage.core.onedrive.stat import stat
from mirage.types import FileType, PathSpec


async def entries(
        accessor: OneDriveAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX
) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total.

    A file has no tree to walk, so it reports no entries and the caller
    falls back to its own size.

    Args:
        accessor (OneDriveAccessor): OneDrive accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path, index=index)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return [], info.size or 0
    _, base = split_path(path)
    return await du_tree_entries(accessor.config,
                                 drive_loc(accessor.config, base),
                                 session=accessor.pool)
