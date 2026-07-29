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
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.ram.dest import check_dest_parents, check_mkdir_target
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm


async def mkdir(accessor: RAMAccessor,
                path_spec: PathSpec,
                parents: bool = False) -> None:
    path = path_spec.mount_path
    store = accessor.store
    p = norm(path)
    check_mkdir_target(store, path_spec, p, parents)
    if parents:
        parts = p.strip("/").split("/")
        current = ""
        now = now_iso()
        for part in parts:
            current += "/" + part
            store.dirs.add(current)
            if current not in store.modified:
                store.modified[current] = now
        await invalidate_after_write(path_spec)
        await invalidate_ancestors(path_spec)
        return
    check_dest_parents(store, path_spec, p)
    store.dirs.add(p)
    store.modified[p] = now_iso()
    await invalidate_after_write(path_spec)
