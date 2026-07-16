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
from mirage.types import PathSpec
from mirage.utils.path import norm


async def du(accessor: RAMAccessor, path_spec: str | PathSpec) -> int:
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    store = accessor.store
    p = norm(path)
    prefix = p.rstrip("/") + "/"
    total = 0
    for key, data in store.files.items():
        if key == p or key.startswith(prefix):
            total += len(data)
    return total


async def du_all(
        accessor: RAMAccessor,
        path_spec: str | PathSpec) -> tuple[list[tuple[str, int]], int]:
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    store = accessor.store
    p = norm(path)
    prefix = p.rstrip("/") + "/"
    entries: list[tuple[str, int]] = []
    total = 0
    for key, data in sorted(store.files.items()):
        if key == p or key.startswith(prefix):
            size = len(data)
            entries.append((key, size))
            total += size
    return entries, total
