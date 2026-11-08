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

from mirage import Policy, Workspace
from mirage.machine.handle import MachineHandle
from mirage.policy import Route
from mirage.runtime.native import NativeRuntime
from mirage.runtime.routing import RouteError
from mirage.runtime.types import RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS


class _Box(MachineHandle):
    provider = "box"

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        return RunResult(
            stdout=f"{self.name}\n".encode(), stderr=None, exit_code=0
        )


def _workspace(*policies: Policy) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[NativeRuntime(["hostname"], machine="a"), "workspace"],
        policies=list(policies),
    )


class _OnB(Policy):
    def pre_execute(self, ctx):
        return Route(machine="b", reason="the other box")


class _ShortOnB(Policy):
    def pre_command(self, ctx):
        return Route(machine="b") if "-s" in ctx.argv else None


class _OnA(Policy):
    def pre_command(self, ctx):
        return Route(machine="a")


@pytest.mark.asyncio
async def test_a_line_runs_on_the_machine_it_names():
    ws = _workspace()
    try:
        assert (await ws.shell("hostname")).stdout == b"a\n"
        assert (await ws.shell("hostname", machine="b")).stdout == b"b\n"
        with pytest.raises(RouteError, match="unknown machine: 'c'"):
            await ws.shell("hostname", machine="c")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_route_places_a_line_on_a_machine():
    ws = _workspace(_OnB())
    try:
        assert (await ws.shell("hostname")).stdout == b"b\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_command_route_places_that_command_alone():
    ws = _workspace(_ShortOnB())
    try:
        said = await ws.shell("hostname; hostname -s; hostname")
        assert said.stdout == b"a\nb\na\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_two_command_routes_that_disagree_refuse_it():
    ws = _workspace(_ShortOnB(), _OnA())
    try:
        said = await ws.shell("hostname -s")
        assert said.exit_code == 126
        assert said.refusal is not None
        assert "_ShortOnB on machine b" in said.refusal.reason
        assert "_OnA on machine a" in said.refusal.reason
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_machine_a_command_runs_on():
    ws = _workspace(_ShortOnB())
    try:
        said = await ws.explain("hostname; hostname -s; ls")
        commands = [node for node in _commands(said.node) if node.command]
        assert [(c.command, c.runtime, c.machine) for c in commands] == [
            ("hostname", "native", "box:a"),
            ("hostname", "native", "box:b"),
            ("ls", "", ""),
        ]
    finally:
        await ws.close()


def _commands(node):
    for child in getattr(node, "children", ()):
        if getattr(child, "type", "") == "command":
            yield child
        yield from _commands(child)
