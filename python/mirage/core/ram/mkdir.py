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
from mirage.cache.context import invalidate_after_write
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm, parent


async def mkdir(accessor: RAMAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    if isinstance(path, PathSpec):
        path = path.mount_path
    store = accessor.store
    p = norm(path)
    if parents:
        parts = p.strip("/").split("/")
        current = ""
        now = now_iso()
        for part in parts:
            current += "/" + part
            store.dirs.add(current)
            if current not in store.modified:
                store.modified[current] = now
        await invalidate_after_write(path)
        return
    parent_dir = parent(p)
    if parent_dir != "/" and parent_dir not in store.dirs:
        raise FileNotFoundError(
            f"parent directory does not exist: {parent_dir}")
    store.dirs.add(p)
    store.modified[p] = now_iso()
    await invalidate_after_write(path)
