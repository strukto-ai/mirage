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
from mirage.cache.context import settle_after_write, write_generation
from mirage.core.ram.dest import check_dest_parents, check_write_target
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm


async def write_bytes(
    accessor: RAMAccessor, path_spec: PathSpec, data: bytes
) -> None:
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    check_dest_parents(store, path_spec, p)
    check_write_target(store, path_spec, p)
    started = write_generation()
    store.files[p] = data
    store.modified[p] = now_iso()
    record("write", path_spec.virtual, "ram", len(data), timer)
    await settle_after_write(path_spec, data, None, started)
