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
from mirage.cache.context import invalidate_after_write
from mirage.core.timeutil import now_iso
from mirage.types import PathSpec
from mirage.utils.path import norm, parent


async def mkdir(
    accessor: RedisAccessor,
    path: PathSpec,
    parents: bool = False,
) -> None:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
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
            await store.add_dir(current)
            mod = await store.get_modified(current)
            if mod is None:
                await store.set_modified(current, now)
        return
    parent_dir = parent(p)
    if parent_dir != "/" and not await store.has_dir(parent_dir):
        raise FileNotFoundError(
            f"parent directory does not exist: {parent_dir}")
    await store.add_dir(p)
    await store.set_modified(p, now_iso())
    await invalidate_after_write(p)
