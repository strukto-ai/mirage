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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.types import PathSpec
from mirage.utils.path import norm


async def size(accessor: RAMAccessor,
               path_spec: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> int:
    """Recursive byte size of everything under a path.

    Args:
        accessor (RAMAccessor): RAM accessor.
        path_spec (PathSpec): target path.
    """
    store = accessor.store
    p = norm(path_spec.mount_path)
    prefix = p.rstrip("/") + "/"
    total = 0
    for key, data in store.files.items():
        if key == p or key.startswith(prefix):
            total += len(data)
    return total
