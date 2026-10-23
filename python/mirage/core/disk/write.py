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

import logging
import os
import tempfile
from contextlib import aclosing
from pathlib import Path

import aiofiles

from mirage.accessor.disk import DiskAccessor
from mirage.concurrency.limiter import run_blocking
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.utils import resolve_inside
from mirage.io.cooperative import chunks
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def write(
    accessor: DiskAccessor, path_spec: PathSpec, data: bytes
) -> None:
    root = accessor.root
    timer = start_op()
    p = await resolve_inside(root, path_spec)
    with disk_errors(path_spec.virtual):
        async with aiofiles.open(p, "wb") as f:
            await f.write(data)
    record("write", path_spec.virtual, "disk", len(data), timer)


async def write_stream(
    accessor: DiskAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    append: bool = False,
    atomic: bool = False,
) -> None:
    """Write with one open handle and bounded asynchronous pulls.

    Args:
        accessor (DiskAccessor): the disk root.
        path_spec (PathSpec): the destination.
        data (ByteSource): bytes consumed once.
        append (bool): append instead of replacing.
        atomic (bool): stage output until successful EOF, retaining the mode.
    """
    timer = start_op()
    p = await resolve_inside(accessor.root, path_spec)
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
            f = await aiofiles.open(
                target, "ab" if append else "wb", buffering=0
            )
        try:
            async with aclosing(chunks(data)) as source:
                async for chunk in source:
                    with disk_errors(path_spec.virtual):
                        await f.write(chunk)
                    size += len(chunk)
        finally:
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
    record(
        "append" if append else "write", path_spec.virtual, "disk", size, timer
    )
