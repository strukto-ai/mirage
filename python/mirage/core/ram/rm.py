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


async def rm_r(accessor: RAMAccessor, path_spec: PathSpec) -> None:
    path = path_spec.mount_path
    store = accessor.store
    p = norm(path)
    prefix = p.rstrip("/") + "/"
    for key in list(store.files):
        if key == p or key.startswith(prefix):
            del store.files[key]
            store.modified.pop(key, None)
            store.attrs.pop(key, None)
    for key in list(store.dirs):
        if key == p or key.startswith(prefix):
            store.dirs.discard(key)
            store.modified.pop(key, None)
            store.attrs.pop(key, None)
    await invalidate_after_unlink(path_spec)
