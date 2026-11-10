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
from mirage.policy import Outcome, Route
from mirage.runtime.machine import MachineRuntime
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
        runtimes=[MachineRuntime(["hostname"], machine="a"), "workspace"],
        policies=list(policies),
    )


def _whole(*policies: Policy) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[MachineRuntime(["@line"], machine="a")],
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


class _EvalOnB(Policy):
    def pre_command(self, ctx):
        return Route(machine="b") if ctx.command == "eval" else None


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
async def test_the_lines_a_routed_command_runs_keep_its_machine():
    ws = _workspace(_EvalOnB())
    try:
        said = await ws.shell("hostname; eval hostname; hostname")
        assert said.stdout == b"a\nb\na\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_run_whole_refuses_a_command_routed_off_it():
    ws = _whole(_ShortOnB())
    try:
        assert (await ws.shell("hostname; hostname")).stdout == b"a\n"
        said = await ws.shell("hostname; hostname -s")
        assert (said.exit_code, said.stdout) == (126, b"")
        assert said.refusal is not None
        assert said.refusal.reason.startswith(
            "_ShortOnB routes hostname elsewhere"
        )
    finally:
        await ws.close()


class _HostnameOnMonty(Policy):
    def pre_command(self, ctx):
        return Route("monty") if ctx.command == "hostname" else None


@pytest.mark.asyncio
async def test_explain_shows_a_line_run_whole_refused_for_a_route():
    ws = _whole(_ShortOnB())
    try:
        kept = await ws.explain("hostname; hostname")
        assert (kept.outcome, kept.exit_code) == (Outcome.ALLOW, 0)
        said = await ws.explain("hostname; hostname -s")
        run = await ws.shell("hostname; hostname -s")
        assert (said.outcome, said.exit_code) == (Outcome.DENY, 126)
        assert said.refusal == run.refusal
        assert said.stderr == await run.stderr_str()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_run_whole_keeps_a_route_that_moves_nothing():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a")},
        runtimes=[MachineRuntime(["@line"], machine="a"), "monty"],
        policies=[_HostnameOnMonty()],
    )
    try:
        assert (await ws.shell("hostname")).stdout == b"a\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_run_whole_keeps_a_route_to_where_it_runs():
    ws = _whole(_OnA())
    try:
        assert (await ws.shell("hostname -s")).stdout == b"a\n"
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
            ("hostname", "machine", "box:a"),
            ("hostname", "machine", "box:b"),
            ("ls", "", ""),
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_machine_a_routed_eval_runs_on():
    ws = _workspace(_EvalOnB())
    try:
        said = await ws.explain("hostname; eval hostname")
        commands = [node for node in _commands(said.node) if node.command]
        assert [(c.command, c.machine) for c in commands] == [
            ("hostname", "box:a"),
            ("eval", ""),
            ("hostname", "box:b"),
        ]
    finally:
        await ws.close()


class _ProgramOnB(Policy):
    def pre_command(self, ctx):
        return Route(machine="b") if ctx.command == "hostname" else None


@pytest.mark.asyncio
async def test_explain_places_a_wrapper_with_its_program():
    ws = _workspace(_ProgramOnB())
    try:
        said = await ws.explain("nohup hostname")
        commands = [node for node in _commands(said.node) if node.command]
        assert [(c.command, c.machine) for c in commands] == [
            ("nohup", "box:b"),
            ("hostname", "box:b"),
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_ignores_a_shell_line_under_a_wrapper():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[MachineRuntime(["nohup", "hostname"], machine="a")],
        policies=[_ProgramOnB()],
    )
    try:
        said = await ws.explain("nohup sh -c hostname")
        first = next(node for node in _commands(said.node) if node.command)
        assert (first.command, first.machine) == ("nohup", "box:a")
        assert (await ws.shell("nohup sh -c hostname")).stdout == b"a\n"
    finally:
        await ws.close()


class _WrapperApart(Policy):
    def pre_command(self, ctx):
        machine = {"nohup": "a", "hostname": "b"}.get(ctx.command)
        return None if machine is None else Route(machine=machine)


@pytest.mark.asyncio
async def test_explain_refuses_a_wrapper_whose_routes_disagree():
    ws = _workspace(_WrapperApart())
    try:
        said = await ws.explain("nohup hostname; echo after")
        wrapper = next(n for n in _commands(said.node) if n.command == "nohup")
        run = await ws.shell("nohup hostname")
        assert (wrapper.outcome, wrapper.exit_code) == (Outcome.DENY, 126)
        assert wrapper.refusal == run.refusal
        assert wrapper.stderr == await run.stderr_str()
        echo = next(n for n in _commands(said.node) if n.command == "echo")
        assert (echo.outcome, echo.exit_code) == (Outcome.ALLOW, 0)
    finally:
        await ws.close()


def _commands(node):
    for child in getattr(node, "children", ()):
        if getattr(child, "type", "") == "command":
            yield child
        yield from _commands(child)
