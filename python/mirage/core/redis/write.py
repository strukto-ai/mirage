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

from contextlib import aclosing

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.dest import check_dest_parents, check_write_target
from mirage.io.cooperative import chunks
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm


async def write(
    accessor: RedisAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Replace a file's bytes, or add them to its end.

    Bytes land at once, as does a stream under ``atomic``, staged until
    it ends. Any other stream lands as it arrives, so a reader watches
    the file grow: a replacement at its own position (``SETRANGE``), as
    an open file's offset keeps it. An append goes at the file's end
    (``APPEND``, which also creates a missing one), so another appender's
    bytes stay, and one that brings nothing leaves an existing file as it
    was (``true >> f``).

    Args:
        accessor (RedisAccessor): the Redis store.
        path_spec (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage a stream until successful EOF.
    """
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    await check_dest_parents(store, path_spec, p)
    await check_write_target(store, path_spec, p)
    op = "append" if append else "write"
    if isinstance(data, bytes) or atomic:
        whole = await materialize(data)
        if not append:
            await store.set_file(p, whole)
        elif whole or not await store.has_file(p):
            await store.append_file(p, whole)
        else:
            return
        await store.set_modified(p, now_iso())
        record(op, path_spec.virtual, "redis", len(whole), timer)
        return
    if not append:
        await store.set_file(p, b"")
        await store.set_modified(p, now_iso())
    elif not await store.has_file(p):
        await store.append_file(p, b"")
        await store.set_modified(p, now_iso())
    size = 0
    # TODO(MIRAGE-33): 1 MiB SETRANGEs, one timestamp each; native pwrite.
    async with aclosing(chunks(data)) as source:
        async for chunk in source:
            if not chunk:
                continue
            if append:
                await store.append_file(p, chunk)
            else:
                await store.set_file_range(p, size, chunk)
            await store.set_modified(p, now_iso())
            size += len(chunk)
    record(op, path_spec.virtual, "redis", size, timer)
