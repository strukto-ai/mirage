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

from mirage import RAMVFS, MountMode, Workspace


@pytest.fixture
def ws():
    return Workspace({"/ram": RAMVFS()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_history_lists_recent_commands(ws):
    await ws.shell("echo hello")
    await ws.shell("echo world")
    io = await ws.shell("history")
    out = (io.stdout or b"").decode()
    assert "echo hello" in out
    assert "echo world" in out
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_history_n_returns_last_n(ws):
    await ws.shell("echo a")
    await ws.shell("echo b")
    await ws.shell("echo c")
    io = await ws.shell("history 2")
    out = (io.stdout or b"").decode()
    lines = [line for line in out.strip().split("\n") if line.strip()]
    assert len(lines) == 2
    assert "echo c" in lines[-1]


@pytest.mark.asyncio
async def test_history_dash_c_clears(ws):
    await ws.shell("echo a")
    await ws.shell("echo b")
    clear_io = await ws.shell("history -c")
    assert clear_io.exit_code == 0
    io = await ws.shell("history")
    out = (io.stdout or b"").decode()
    lines = [line for line in out.strip().split("\n") if line.strip()]
    assert len(lines) == 1
    assert "history" in lines[-1]


@pytest.mark.asyncio
async def test_history_invalid_numeric_arg(ws):
    await ws.shell("echo a")
    io = await ws.shell("history abc")
    assert io.exit_code == 1
    err = (io.stderr or b"").decode()
    assert "numeric" in err


@pytest.mark.asyncio
async def test_history_isolated_per_session(ws):
    ws.create_session("alice")
    ws.create_session("bob")
    await ws.shell("echo from-alice", session_id="alice")
    await ws.shell("echo from-bob", session_id="bob")
    io_a = await ws.shell("history", session_id="alice")
    out_a = (io_a.stdout or b"").decode()
    assert "from-alice" in out_a
    assert "from-bob" not in out_a
    io_b = await ws.shell("history", session_id="bob")
    out_b = (io_b.stdout or b"").decode()
    assert "from-bob" in out_b
    assert "from-alice" not in out_b
