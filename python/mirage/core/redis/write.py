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
    data: bytes,
) -> None:
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    await check_dest_parents(store, path_spec, p)
    await check_write_target(store, path_spec, p)
    await store.set_file(p, data)
    await store.set_modified(p, now_iso())
    record("write", path_spec.virtual, "redis", len(data), timer)


async def write_stream(
    accessor: RedisAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Write bytes as they arrive, each chunk appended where it lands
    (``APPEND``), so a reader watches the file grow and another appender's
    bytes stay. ``atomic`` stages the replacement until it ends.

    Args:
        accessor (RedisAccessor): the Redis store.
        path_spec (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage output until successful EOF.
    """
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    await check_dest_parents(store, path_spec, p)
    await check_write_target(store, path_spec, p)
    op = "append" if append else "write"
    if atomic:
        whole = await materialize(data)
        await store.set_file(p, whole)
        await store.set_modified(p, now_iso())
        record(op, path_spec.virtual, "redis", len(whole), timer)
        return
    if not append:
        await store.set_file(p, b"")
    else:
        await store.append_file(p, b"")
    await store.set_modified(p, now_iso())
    size = 0
    async with aclosing(chunks(data)) as source:
        async for chunk in source:
            await store.append_file(p, chunk)
            await store.set_modified(p, now_iso())
            size += len(chunk)
    record(op, path_spec.virtual, "redis", size, timer)
