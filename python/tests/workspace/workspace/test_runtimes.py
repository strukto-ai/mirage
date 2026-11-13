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

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.types import materialize
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import Program, RunResult


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

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
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

    async def run_line(self, engine, paths, texts, ctx):
        self.entered.set()
        await self.release.wait()
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def workspace(*runtimes):
    return Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, machines=[*runtimes]
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
        await ws.remove_machine("alpha")
        assert await python3(ws) == (0, b"beta\n", b"")
        assert alpha.closed == 1
        with pytest.raises(ValueError, match="construct a new one"):
            ws.add_machine(alpha.name, alpha)
    finally:
        await ws.close()
    assert alpha.closed == 1


@pytest.mark.asyncio
async def test_a_refused_add_leaves_the_engine_its_name():
    alpha = Engine("alpha")
    first, second = workspace(alpha), workspace()
    try:
        with pytest.raises(ValueError, match="another workspace"):
            second.add_machine("renamed", alpha)
        with pytest.raises(ValueError, match="duplicate machine"):
            first.add_machine("again", alpha)
        assert alpha.name == "alpha"
        assert await python3(first, machine="alpha") == (0, b"alpha\n", b"")
    finally:
        await first.close()
        await second.close()


@pytest.mark.asyncio
async def test_remove_waits_for_a_running_line_before_closing():
    alpha = Engine("alpha")
    alpha.release.clear()
    ws = workspace(alpha)
    try:
        line = asyncio.create_task(python3(ws))
        await alpha.entered.wait()
        removing = asyncio.create_task(ws.remove_machine("alpha"))
        await asyncio.sleep(0.01)
        assert not removing.done() and alpha.closed == 0
        alpha.release.set()
        assert await line == (0, b"alpha\n", b"")
        await asyncio.wait_for(removing, 5)
        assert alpha.closed == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_keeps_its_runtime_when_a_same_named_one_replaces_it():
    alpha, gate = Engine("alpha"), Gate()
    ws = workspace(gate, alpha)
    try:
        line = asyncio.create_task(
            ws.shell("gate; python3 -c x", machine="alpha")
        )
        await gate.entered.wait()
        await ws.remove_machine("alpha")
        replacement = Engine("alpha")
        ws.add_machine(replacement.name, replacement)
        gate.release.set()
        io = await line
        assert io.exit_code == 1
        assert await materialize(io.stderr) == (
            b"python3: alpha: runtime was removed from the workspace\n"
        )
        assert not replacement.entered.is_set()
        assert await python3(ws) == (0, b"alpha\n", b"")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_close_settles_a_removal_and_closes_the_runtime_once():
    alpha = Engine("alpha")
    alpha.release.clear()
    ws = workspace(alpha)
    line = asyncio.create_task(python3(ws))
    await alpha.entered.wait()
    removing = asyncio.create_task(ws.remove_machine("alpha"))
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
    removing = asyncio.create_task(ws.remove_machine("alpha"))
    await asyncio.sleep(0)
    removing.cancel()
    alpha.release.set()
    await line
    with pytest.raises(RuntimeError, match="close failed"):
        await ws.close()


class Box(Runtime, LineExecutorMixin):
    """A line executor on another machine, as a sandbox is."""

    reach = "remote"

    def __init__(self, name: str, *captures: str) -> None:
        super().__init__(captures=captures or ("@external",))
        self.name = name

    async def run_line(self, engine, paths, texts, ctx):
        return RunResult(
            stdout=f"{self.name}\n".encode(), stderr=None, exit_code=0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "listed, added, order",
    [
        (
            [Engine("a")],
            [Box("b1"), Box("b2")],
            ["b1", "b2", "a", "workspace"],
        ),
        (
            [Engine("a"), Box("b1")],
            [Box("b2")],
            ["a", "b1", "b2", "workspace"],
        ),
        (
            [Engine("a")],
            [Engine("b"), Box("b1")],
            ["b1", "a", "workspace", "b"],
        ),
        (
            [Gate(), Engine("a")],
            [Box("b1")],
            ["gate", "b1", "a", "workspace"],
        ),
        ([Gate()], [Box("b1")], ["gate", "workspace", "b1"]),
    ],
)
async def test_an_added_sandbox_goes_after_the_last_sandbox_or_the_languages(
    listed, added, order
):
    ws = workspace(*listed)
    try:
        for entry in added:
            ws.add_machine(entry.name, entry)
        assert [r.name for r in ws.engines()] == order
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_python3_captured_on_an_added_sandbox_wins():
    ws = workspace(Engine("monty"))
    try:
        ws.add_machine("box", Box("box", "python3"))
        assert await python3(ws) == (0, b"box\n", b"")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_capture_that_never_wins_is_logged(caplog):
    caplog.set_level(logging.WARNING, logger="mirage.workspace.workspace")
    ws = workspace(Engine("a"), Engine("b"))
    try:
        ws.add_machine("box", Box("box", "python3"))
        said = [r.getMessage() for r in caplog.records]
        shadowed = [
            ("b", "python3", "a"),
            ("b", "python", "a"),
            ("a", "python3", "box"),
            ("b", "python3", "box"),
            ("b", "python", "a"),
        ]
        assert said == [
            f"machine '{entry}' runs '{capture}' only when a route names it: "
            f"'{winner}', listed before it, takes it"
            for entry, capture, winner in shadowed
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_capture_is_logged_only_while_no_route_policy_can_reach_it(
    caplog,
):
    caplog.set_level(logging.WARNING, logger="mirage.workspace.workspace")
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[Engine("a"), Engine("b")],
        route_policy=lambda ctx: "b" if "fast" in ctx.line else None,
    )
    try:
        assert [r.getMessage() for r in caplog.records] == []
        ws.policies.place(None)
        ws.add_machine("box", Box("box", "python"))
        said = [r.getMessage() for r in caplog.records]
        assert said[0] == (
            "machine 'a' runs 'python' only when a route names it: "
            "'box', listed before it, takes it"
        )
    finally:
        await ws.close()
