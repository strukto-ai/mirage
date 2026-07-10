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

from mirage import MountMode, RAMResource, Workspace


async def _workspace() -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("echo hi > /data/sub/x.txt")
    await ws.execute("cd /data")
    return ws


@pytest.mark.asyncio
async def test_drain_error_respells_relative_operand():
    # cat of a directory errors on the first lazy pull, past the eager
    # chokepoint; the drain must still report the operand as typed.
    ws = await _workspace()
    io = await ws.execute("cat sub")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert err.startswith("cat: sub: ")


@pytest.mark.asyncio
async def test_drain_error_keeps_absolute_operand():
    ws = await _workspace()
    io = await ws.execute("cat /data/sub")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert err.startswith("cat: /data/sub: ")


@pytest.mark.asyncio
async def test_eager_error_respells_relative_operand():
    ws = await _workspace()
    io = await ws.execute("cat sub/missing.txt")
    assert io.exit_code == 1
    assert (io.stderr or b"").decode() == (
        "cat: sub/missing.txt: No such file or directory\n")
