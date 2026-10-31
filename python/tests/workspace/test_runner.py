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
import threading
import time

import pytest

from mirage import MountMode, Workspace, WorkspaceRunner
from mirage.vfs.ram import RAMVFS
from mirage.workspace import runner as runner_module


def _runners() -> set[threading.Thread]:
    return {
        t for t in threading.enumerate() if t.name.startswith("mirage-ws-")
    }


async def _built() -> Workspace:
    return _make_ws()


async def _refused() -> Workspace:
    raise ValueError("bad config")


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
            runner_a.call(runner_a.ws.shell("sleep 1.0"))
        )
        await asyncio.sleep(0.05)
        start = time.monotonic()
        fast_result = await runner_b.call(runner_b.ws.shell("echo quick"))
        elapsed = time.monotonic() - start
        assert fast_result.exit_code == 0
        assert elapsed < 0.5, (
            f"workspace B's quick command took {elapsed:.2f}s "
            "while workspace A was sleeping; isolation violated"
        )
        await slow
    finally:
        await runner_a.stop()
        await runner_b.stop()


@pytest.mark.asyncio
async def test_work_is_refused_once_stop_begins():
    runner = WorkspaceRunner(_make_ws())
    stopping = asyncio.create_task(runner.stop())
    await asyncio.sleep(0)
    for _ in range(2):
        line = runner.ws.shell("echo late")
        with pytest.raises(RuntimeError, match="stopped"):
            await runner.call(line)
        assert line.cr_frame is None
        await stopping


@pytest.mark.asyncio
async def test_cancelled_call_waits_for_the_work_to_settle():
    runner = WorkspaceRunner(_make_ws())
    entered, cleaned = threading.Event(), threading.Event()

    async def work():
        entered.set()
        try:
            await asyncio.sleep(10)
        finally:
            await asyncio.sleep(0.05)
            cleaned.set()

    call = asyncio.create_task(runner.call(work()))
    assert await asyncio.to_thread(entered.wait, 2)
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert cleaned.is_set()
    await asyncio.gather(runner.stop(), runner.stop())


@pytest.mark.asyncio
async def test_stop_is_idempotent():
    ws = _make_ws()
    runner = WorkspaceRunner(ws)
    await runner.stop()
    await runner.stop()
    assert not runner._thread.is_alive()


@pytest.mark.asyncio
async def test_build_constructs_the_workspace_on_the_runners_thread():
    built_on = []

    async def make() -> Workspace:
        built_on.append(threading.current_thread())
        return _make_ws()

    runner = await WorkspaceRunner.build(make())
    try:
        assert built_on == [runner._thread]
        result = await runner.call(runner.ws.shell("echo built"))
        assert (await result.stdout_str()) == "built\n"
    finally:
        await runner.stop()


@pytest.mark.asyncio
async def test_a_failed_build_stops_the_thread_it_started():
    before = _runners()

    with pytest.raises(ValueError, match="bad config"):
        await WorkspaceRunner.build(_refused())
    assert _runners() == before


@pytest.mark.asyncio
async def test_a_caller_cancelled_after_the_build_still_closes_it(monkeypatch):
    closed: list[Workspace] = []
    real_close = Workspace.close
    real_on_loop = runner_module.on_loop
    calls = 0

    async def spy(self: Workspace) -> None:
        closed.append(self)
        await real_close(self)

    async def cancelled_once_built(work, loop):
        nonlocal calls
        calls += 1
        result = await real_on_loop(work, loop)
        if calls == 1:
            raise asyncio.CancelledError()
        return result

    monkeypatch.setattr(Workspace, "close", spy)
    monkeypatch.setattr(runner_module, "on_loop", cancelled_once_built)
    before = _runners()
    with pytest.raises(asyncio.CancelledError):
        await WorkspaceRunner.build(_built())
    assert len(closed) == 1
    assert _runners() == before
