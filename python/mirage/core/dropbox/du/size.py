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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dropbox.du.walk import walk
from mirage.types import PathSpec


async def size(
    accessor: DropboxAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> int:
    """Recursive byte size of everything under a path.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): target path.
        index (IndexCacheStore): path->metadata index cache.
    """
    return await walk(accessor, path, index, None)
