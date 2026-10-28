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
    lookup_error,
)
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm


async def copy(
    accessor: RAMAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    """Copy one key onto another.

    A live pipe at either end is used as one: a pipe source is read
    through its reader and a pipe destination written into, so no bytes
    land in a row no reader sees (GNU: ``cp <(printf x) f`` and ``cp f
    >(cat)`` both deliver).

    Args:
        accessor (RAMAccessor): the RAM accessor.
        src_spec (PathSpec): the key to copy.
        dst_spec (PathSpec): the key to write.
    """
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    store = accessor.store
    s, d = norm(src), norm(dst)
    check_dest_parents(store, dst_spec, d)
    source = active_pipe(accessor, s)
    target = active_pipe(accessor, d)
    if source is not None and target is not None:
        async for chunk in source.stream(src_spec):
            await target.write(chunk, dst_spec)
        return
    if source is not None:
        data = await source.read(src_spec)
        # The copy held no names while it waited on the pipe, so another
        # job may have moved or replaced the destination meanwhile: check
        # it again, as a write would, before storing.
        check_dest_parents(store, dst_spec, d)
    elif s in store.files:
        data = store.files[s]
    else:
        raise lookup_error(store, src_spec, s)
    if target is not None:
        await target.write(data, dst_spec)
        return
    check_write_target(store, dst_spec, d)
    check_capacity(store, dst_spec, d, len(data))
    store.files[d] = data
    store.modified[d] = now_iso()
