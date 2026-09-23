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

import pytest

from mirage import MountMode, Workspace, WorkspaceRunner
from mirage.vfs.ram import RAMVFS


def _make_ws() -> Workspace:
    return Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


@pytest.mark.asyncio
async def test_runner_executes_on_its_own_loop():
    ws = _make_ws()
    runner = WorkspaceRunner(ws)
    try:
        outer = asyncio.get_running_loop()
        assert runner.loop is not outer
        result = await runner.call(runner.ws.shell("echo hello"))
        assert result.exit_code == 0
        assert (result.stdout or b"").startswith(b"hello")
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_runner_call_does_not_block_caller_loop():
    ws = _make_ws()
    runner = WorkspaceRunner(ws)
    try:
        slow = asyncio.create_task(runner.call(runner.ws.shell("sleep 0.5")))
        ticks = 0
        for _ in range(20):
            await asyncio.sleep(0.05)
            ticks += 1
            if slow.done():
                break
        assert ticks >= 5
        await slow
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_two_runners_are_isolated():
    ws_a = _make_ws()
    ws_b = _make_ws()
    runner_a = WorkspaceRunner(ws_a)
    runner_b = WorkspaceRunner(ws_b)
    try:
        slow = asyncio.create_task(
            runner_a.call(runner_a.ws.shell("sleep 1.0")))
        await asyncio.sleep(0.05)
        start = time.monotonic()
        fast_result = await runner_b.call(runner_b.ws.shell("echo quick"))
        elapsed = time.monotonic() - start
        assert fast_result.exit_code == 0
        assert elapsed < 0.5, (
            f"workspace B's quick command took {elapsed:.2f}s "
            "while workspace A was sleeping; isolation violated")
        await slow
    finally:
        await runner_a.stop()
        await runner_b.stop()


@pytest.mark.asyncio
async def test_stop_is_idempotent():
    ws = _make_ws()
    runner = WorkspaceRunner(ws)
    await runner.stop()
    await runner.stop()
    assert not runner._thread.is_alive()


def test_call_sync_runs_on_workspace_loop():
    ws = _make_ws()
    runner = WorkspaceRunner(ws)
    try:
        result = runner.call_sync(runner.ws.shell("echo sync"), timeout=5.0)
        assert result.exit_code == 0
        assert (result.stdout or b"").startswith(b"sync")
    finally:
        runner.call_sync(runner.ws.close(), timeout=5.0)
        runner.loop.call_soon_threadsafe(runner.loop.stop)
        runner._thread.join(timeout=2.0)
        runner.loop.close()
