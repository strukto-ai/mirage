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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.types import PathSpec
from mirage.utils.path import norm


async def entries(
        accessor: RedisAccessor,
        path_spec: PathSpec,
        index: IndexCacheStore = NULL_INDEX
) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total.

    Paths are mount-relative and leaf files only; the caller lifts them
    onto virtual paths and renders any roll-up line itself.

    Args:
        accessor (RedisAccessor): Redis accessor.
        path_spec (PathSpec): target path.
    """
    store = accessor.store
    p = norm(path_spec.mount_path)
    prefix = p.rstrip("/") + "/"
    found: list[tuple[str, int]] = []
    total = 0
    for key in sorted(await store.list_files()):
        if key == p or key.startswith(prefix):
            file_size = await store.file_len(key)
            found.append((key, file_size))
            total += file_size
    return found, total
