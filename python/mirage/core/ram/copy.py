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
from mirage.utils.path import norm


async def copy(accessor: RAMAccessor, src_spec: PathSpec,
               dst_spec: PathSpec) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    if s not in store.files:
        raise FileNotFoundError(s)
    store.files[d] = store.files[s]
    store.modified[d] = now_iso()
    await invalidate_after_write(dst_spec)
