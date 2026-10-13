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

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.types import materialize
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import RunArgs, RunResult


class Engine(PythonRuntime):
    """A python3 engine that answers its own name and records closing."""

    def __init__(self, name: str, close_error: str | None = None) -> None:
        super().__init__()
        self.name = name
        self.close_error = close_error
        self.closed = 0
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def run(self, args: RunArgs) -> RunResult:
        self.entered.set()
        await self.release.wait()
        return RunResult(
            stdout=f"{self.name}\n".encode(), stderr=None, exit_code=0
        )

    async def close(self) -> None:
        self.closed += 1
        if self.close_error is not None:
            raise RuntimeError(self.close_error)


class Gate(Runtime, LineExecutorMixin):
    name = "gate"
    captures = ("gate",)

    def __init__(self) -> None:
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def run_line(self, line, stdin, env, cwd):
        self.entered.set()
        await self.release.wait()
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def workspace(*runtimes):
    return Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[*runtimes, "workspace"]
    )


async def python3(ws, **kwargs):
    io = await ws.shell("python3 -c x", **kwargs)
    return (
        io.exit_code,
        await materialize(io.stdout),
        await materialize(io.stderr),
    )


@pytest.mark.asyncio
async def test_swap_by_remove_then_add_and_a_removed_instance_stays_out():
    alpha, beta = Engine("alpha"), Engine("beta")
    ws = workspace(alpha, beta)
    try:
        assert await python3(ws) == (0, b"alpha\n", b"")
        await ws.remove_runtime("alpha")
        assert await python3(ws) == (0, b"beta\n", b"")
        assert alpha.closed == 1
        with pytest.raises(ValueError, match="construct a new one"):
            ws.add_runtime(alpha)
    finally:
        await ws.close()
    assert alpha.closed == 1


@pytest.mark.asyncio
async def test_remove_waits_for_a_running_line_before_closing():
    alpha = Engine("alpha")
    alpha.release.clear()
    ws = workspace(alpha)
    try:
        line = asyncio.create_task(python3(ws))
        await alpha.entered.wait()
        removing = asyncio.create_task(ws.remove_runtime("alpha"))
        await asyncio.sleep(0.01)
        assert not removing.done() and alpha.closed == 0
        alpha.release.set()
        assert await line == (0, b"alpha\n", b"")
        await asyncio.wait_for(removing, 5)
        assert alpha.closed == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_routed_before_removal_is_refused_after_it():
    alpha, gate = Engine("alpha"), Gate()
    ws = workspace(gate, alpha)
    try:
        line = asyncio.create_task(
            ws.shell("gate; python3 -c x", runtime="alpha")
        )
        await gate.entered.wait()
        await ws.remove_runtime("alpha")
        gate.release.set()
        io = await line
        assert io.exit_code == 1
        assert await materialize(io.stderr) == (
            b"python3: alpha: runtime was removed from the workspace\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_close_settles_a_removal_and_closes_the_runtime_once():
    alpha = Engine("alpha")
    alpha.release.clear()
    ws = workspace(alpha)
    line = asyncio.create_task(python3(ws))
    await alpha.entered.wait()
    removing = asyncio.create_task(ws.remove_runtime("alpha"))
    await asyncio.sleep(0)
    await asyncio.wait_for(ws.close(), 5)
    assert line.cancelled()
    assert removing.done() and removing.exception() is None
    assert alpha.closed == 1


@pytest.mark.asyncio
async def test_a_cancelled_removal_still_reports_its_close_failure():
    alpha = Engine("alpha", close_error="close failed")
    alpha.release.clear()
    ws = workspace(alpha)
    line = asyncio.create_task(python3(ws))
    await alpha.entered.wait()
    removing = asyncio.create_task(ws.remove_runtime("alpha"))
    await asyncio.sleep(0)
    removing.cancel()
    alpha.release.set()
    await line
    with pytest.raises(RuntimeError, match="close failed"):
        await ws.close()
