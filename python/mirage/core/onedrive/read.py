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
from mirage.core.msgraph.drive import read_item
from mirage.core.onedrive.client import drive_loc
from mirage.types import PathSpec


async def read(
    accessor: OneDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (OneDriveAccessor): OneDrive accessor.
        path (PathSpec): the path to read.
        index (IndexCacheStore): unused; Graph resolves the item from the
            path itself.
        offset (int): first byte of the window.
        size (int | None): window length, or None for the rest.
    """
    return await read_item(
        accessor.config,
        drive_loc(accessor.config, path.vfs_path),
        path.virtual,
        "onedrive",
        offset=offset,
        size=size,
        session=accessor.pool,
    )
