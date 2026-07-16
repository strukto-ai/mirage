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
from mirage.utils.path import norm


async def copy(
    accessor: RedisAccessor,
    src_spec: str | PathSpec,
    dst_spec: str | PathSpec,
) -> None:
    src = src_spec.mount_path if isinstance(src_spec, PathSpec) else src_spec
    dst = dst_spec.mount_path if isinstance(dst_spec, PathSpec) else dst_spec
    store = accessor.store
    s, d = norm(src), norm(dst)
    data = await store.get_file(s)
    if data is None:
        raise FileNotFoundError(s)
    await store.set_file(d, data)
    await store.set_modified(d, now_iso())
    await invalidate_after_write(dst)
