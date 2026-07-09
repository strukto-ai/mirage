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
    await ws.execute("tee /data/plain.txt > /dev/null", stdin=b"y\n")
    await ws.execute("cd /data")
    return ws


async def _rc(ws: Workspace, cmd: str) -> int:
    io = await ws.execute(cmd)
    return io.exit_code


@pytest.mark.asyncio
async def test_f_relative_resolves_against_cwd():
    ws = await _workspace()
    assert await _rc(ws, "test -f plain.txt") == 0


@pytest.mark.asyncio
async def test_f_relative_missing():
    ws = await _workspace()
    assert await _rc(ws, "test -f missing.txt") == 1


@pytest.mark.asyncio
async def test_f_relative_with_dotdot():
    ws = await _workspace()
    await ws.execute("cd /data/sub")
    assert await _rc(ws, "test -f ../plain.txt") == 0


@pytest.mark.asyncio
async def test_d_relative_resolves_against_cwd():
    ws = await _workspace()
    assert await _rc(ws, "test -d sub") == 0


@pytest.mark.asyncio
async def test_d_relative_missing():
    ws = await _workspace()
    assert await _rc(ws, "test -d nosuch") == 1


@pytest.mark.asyncio
async def test_f_absolute_unchanged():
    ws = await _workspace()
    assert await _rc(ws, "test -f /data/plain.txt") == 0


@pytest.mark.asyncio
async def test_f_empty_operand_false():
    ws = await _workspace()
    assert await _rc(ws, 'test -f ""') == 1


@pytest.mark.asyncio
async def test_bracket_form_relative():
    ws = await _workspace()
    assert await _rc(ws, "[ -f plain.txt ]") == 0


@pytest.mark.asyncio
async def test_negation_relative():
    ws = await _workspace()
    assert await _rc(ws, "test ! -f missing.txt") == 0
