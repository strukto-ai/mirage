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
from mirage.core.dev.device import active_pipe
from mirage.core.ram.dest import (
    check_capacity,
    check_dest_parents,
    check_write_target,
)
from mirage.errors.fs import einval
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm


async def truncate(
    accessor: RAMAccessor, path: PathSpec, length: int, no_create: bool = False
) -> None:
    """Set one key's length, padding with NULs or cutting it short.

    A live pipe has no length to set: EINVAL, as ftruncate(2) answers
    for one (GNU: ``truncate -s 0 >(cat)`` is "Invalid argument"), and
    for a length that is not a whole, non-negative number of bytes.

    Args:
        accessor (RAMAccessor): the RAM accessor.
        path (PathSpec): the key to truncate.
        length (int): the new length.
        no_create (bool): leave an absent key absent.
    """
    store = accessor.store
    timer = start_op()
    p = norm(path.mount_path)
    if (
        active_pipe(accessor, p) is not None
        or not isinstance(length, int)
        or length < 0
    ):
        raise einval(path)
    check_dest_parents(store, path, p)
    check_write_target(store, path, p)
    if p in store.files:
        data = store.files[p]
    else:
        if no_create:
            return
        data = b""
    check_capacity(store, path, p, length)
    store.files[p] = data[:length].ljust(length, b"\0")
    store.modified[p] = now_iso()
    record("truncate", path.virtual, "ram", 0, timer)
