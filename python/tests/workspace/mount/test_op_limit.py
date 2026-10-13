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

import pytest

from mirage import MountMode, Workspace
from mirage.mount.core import MountCore
from mirage.types import Limit, OnExceed
from mirage.vfs.ram import RAMVFS

DATA = b"".join(b"line %d\n" % i for i in range(1, 201))


async def _capped_ws(warm: bool, on_exceed: OnExceed) -> Workspace:
    resource = RAMVFS()
    resource.caches_reads = warm
    resource._store.files["/f.txt"] = DATA
    ws = Workspace({"/data/": resource}, mode=MountMode.WRITE)
    await ws.namespace.ensure_loaded()
    if warm:
        await ws.cache.set("/data/f.txt", DATA, ttl=600)
    mount = ws.namespace.mount_for("/data/f.txt")
    mount.command_limits["read"] = Limit(
        max_lines=3, max_bytes=5, on_exceed=on_exceed
    )
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True])
@pytest.mark.parametrize("on_exceed", [OnExceed.TRUNCATE, OnExceed.ERROR])
async def test_a_mount_read_entry_never_cuts_a_file_call(warm, on_exceed):
    ws = await _capped_ws(warm, on_exceed)
    try:
        assert await ws.vfs.read("/data/f.txt") == DATA
        assert await ws.vfs.read("/data/f.txt", 100, 200) == DATA[100:300]
        assert await ws.vfs.read("/data/f.txt", 100) == DATA[100:]
        streamed = [c async for c in await ws.vfs.read_stream("/data/f.txt")]
        assert b"".join(streamed) == DATA
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True])
async def test_a_kernel_mount_reads_a_capped_file_whole(warm):
    ws = await _capped_ws(warm, OnExceed.TRUNCATE)
    core = MountCore(ws.vfs)
    try:
        fh = await core.open("/data/f.txt")
        got = b""
        while piece := await core.read("/data/f.txt", 64, len(got), fh):
            got += piece
        await core.release(fh)
        assert got == DATA
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_lines_own_reads_ignore_the_mount_read_entry():
    ws = await _capped_ws(False, OnExceed.TRUNCATE)
    try:
        io = await ws.shell("cat /data/f.txt | wc -l")
        assert (await io.stdout_str()).strip() == "200"
    finally:
        await ws.close()
