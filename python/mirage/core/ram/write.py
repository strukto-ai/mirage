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

import asyncio
import time
from contextlib import aclosing

from mirage.accessor.ram import RAMAccessor
from mirage.core.dev.device import active_pipe
from mirage.core.ram.constants import STREAM_PUBLISH_SECONDS
from mirage.core.ram.dest import check_dest_parents, check_write_target
from mirage.io.cooperative import chunks
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.dates import now_iso
from mirage.utils.path import norm


async def write(
    accessor: RAMAccessor, path_spec: PathSpec, data: bytes
) -> None:
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    pipe = active_pipe(accessor, p)
    if pipe is not None:
        await pipe.write(data, path_spec)
        record("write", path_spec.virtual, "ram", len(data), timer)
        return
    check_dest_parents(store, path_spec, p)
    check_write_target(store, path_spec, p)
    store.files[p] = data
    store.modified[p] = now_iso()
    record("write", path_spec.virtual, "ram", len(data), timer)


async def write_stream(
    accessor: RAMAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Write bytes as they arrive, so a reader watches the file grow.

    What has arrived lands within ``STREAM_PUBLISH_SECONDS``, a writer
    gone quiet included, and at the end, appended to what the file holds
    then, so another appender's bytes stay. ``atomic`` stages the replacement until it
    ends.

    Args:
        accessor (RAMAccessor): the RAM store.
        path_spec (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage output until successful EOF.
    """
    path = path_spec.mount_path
    store = accessor.store
    timer = start_op()
    p = norm(path)
    size = 0
    pipe = active_pipe(accessor, p)
    if pipe is not None:
        async with aclosing(chunks(data)) as source:
            async for chunk in source:
                await pipe.write(chunk, path_spec)
                size += len(chunk)
        record(
            "append" if append else "write",
            path_spec.virtual,
            "ram",
            size,
            timer,
        )
        return
    check_dest_parents(store, path_spec, p)
    check_write_target(store, path_spec, p)
    if atomic:
        whole = await materialize(data)
        store.files[p] = whole
        store.modified[p] = now_iso()
        record("write", path_spec.virtual, "ram", len(whole), timer)
        return
    if not append or p not in store.files:
        store.files[p] = b"" if not append else store.files.get(p, b"")
        store.modified[p] = now_iso()
    pending: list[bytes] = []
    position = 0
    last = time.monotonic()
    later: asyncio.TimerHandle | None = None

    def publish() -> None:
        nonlocal position, last, later
        if later is not None:
            later.cancel()
            later = None
        last = time.monotonic()
        if not pending:
            return
        data = b"".join(pending)
        pending.clear()
        current = store.files.get(p, b"")
        if append:
            store.files[p] = current + data
        else:
            current = current.ljust(position, b"\0")
            store.files[p] = (
                current[:position] + data + current[position + len(data) :]
            )
            position += len(data)
        store.modified[p] = now_iso()

    try:
        async with aclosing(chunks(data)) as source:
            async for chunk in source:
                pending.append(chunk)
                size += len(chunk)
                wait = STREAM_PUBLISH_SECONDS - (time.monotonic() - last)
                if wait <= 0:
                    publish()
                elif later is None:
                    later = asyncio.get_running_loop().call_later(
                        wait, publish
                    )
    finally:
        publish()
    record(
        "append" if append else "write", path_spec.virtual, "ram", size, timer
    )
