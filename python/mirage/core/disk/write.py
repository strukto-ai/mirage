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
import logging
import os
import tempfile
from contextlib import aclosing
from pathlib import Path

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.concurrency.limiter import run_blocking
from mirage.core.disk.constants import STREAM_FLUSH_SECONDS
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def write(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Replace a file's bytes, or add them to its end, with one open
    handle: bytes in one write, a stream in bounded asynchronous pulls,
    flushed now and then so a reader watches the file grow.

    Args:
        accessor (DiskAccessor): the disk root.
        path_spec (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage output until successful EOF, retaining the mode.
    """
    op = "append" if append else "write"
    timer = start_op()
    p = await resolve_inside(accessor.root, path_spec)
    if isinstance(data, bytes) and not atomic:
        with disk_errors(path_spec.virtual):
            async with aiofiles.open(p, "ab" if append else "wb") as f:
                await f.write(data)
        record(op, path_spec.virtual, "disk", len(data), timer)
        return
    size = 0
    staged: list[str] = []
    mode = None

    def stage() -> str:
        fd, name = tempfile.mkstemp(dir=p.parent, prefix=".mirage-")
        staged.append(name)
        os.close(fd)
        return name

    try:
        with disk_errors(path_spec.virtual):
            target = p
            if atomic:
                try:
                    mode = (await run_blocking(p.stat)).st_mode & 0o7777
                except FileNotFoundError:
                    pass
                target = Path(await run_blocking(stage))
            f = await aiofiles.open(target, "ab" if append else "wb")
        lock = asyncio.Lock()
        dirty = False

        async def flush_now_and_then() -> None:
            nonlocal dirty
            while True:
                await asyncio.sleep(STREAM_FLUSH_SECONDS)
                if not dirty:
                    continue
                async with lock:
                    try:
                        await f.flush()
                    except OSError as exc:
                        logger.debug("streamed write not flushed: %s", exc)
                        return
                    dirty = False

        flushing = (
            None if atomic else asyncio.create_task(flush_now_and_then())
        )
        try:
            async with aclosing(chunks(data)) as source:
                async for chunk in source:
                    async with lock:
                        with disk_errors(path_spec.virtual):
                            await f.write(chunk)
                        dirty = True
                    size += len(chunk)
        finally:
            if flushing is not None:
                flushing.cancel()
                await asyncio.gather(flushing, return_exceptions=True)
            with disk_errors(path_spec.virtual):
                await f.close()
        if staged:
            with disk_errors(path_spec.virtual):
                if mode is not None:
                    await run_blocking(os.chmod, staged[0], mode)
                await run_blocking(os.replace, staged[0], p)
            staged.clear()
    finally:
        if staged:
            try:
                await run_blocking(os.unlink, staged[0])
            except FileNotFoundError:
                logger.debug(
                    "staged output already moved: %s", path_spec.virtual
                )
    record(op, path_spec.virtual, "disk", size, timer)
