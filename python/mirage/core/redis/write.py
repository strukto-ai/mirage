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

import time

from mirage.accessor.redis import RedisAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.timeutil import now_iso
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.path import norm, parent


async def write_bytes(
    accessor: RedisAccessor,
    path_spec: str | PathSpec,
    data: bytes,
) -> None:
    path = path_spec.mount_path if isinstance(path_spec,
                                              PathSpec) else path_spec
    store = accessor.store
    start_ms = int(time.monotonic() * 1000)
    p = norm(path)
    parent_dir = parent(p)
    if parent_dir != "/" and not await store.has_dir(parent_dir):
        raise FileNotFoundError(
            f"parent directory does not exist: {parent_dir}")
    await store.set_file(p, data)
    await store.set_modified(p, now_iso())
    record("write", path, "redis", len(data), start_ms)
    await invalidate_after_write(path)
