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
from mirage.cache.context import invalidate_after_unlink
from mirage.types import PathSpec
from mirage.utils.path import norm


async def rmdir(accessor: RAMAccessor, path: PathSpec) -> None:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    if isinstance(path, PathSpec):
        path = path.mount_path
    store = accessor.store
    p = norm(path)
    if p not in store.dirs:
        raise FileNotFoundError(p)
    prefix = p.rstrip("/") + "/"
    children = [
        k for k in list(store.files) + list(store.dirs)
        if k.startswith(prefix) and k != p
    ]
    if children:
        raise OSError(f"directory not empty: {p}")
    store.dirs.discard(p)
    await invalidate_after_unlink(path)
