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
from mirage.policy import Ask, Deny, Outcome, Route
from mirage.policy.types import Scope
from mirage.runtime.machine import RemoteRuntime
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
        runtimes=[RemoteRuntime(["hostname"], machine="a"), "workspace"],
        policies=list(policies),
    )


def _whole(*policies: Policy) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[RemoteRuntime(["@line"], machine="a")],
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
        assert said.decision is not None
        assert said.decision.reason.startswith(
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
        assert said.decision == run.decision
        assert said.stderr == await run.stderr_str()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_run_whole_keeps_a_route_that_moves_nothing():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a")},
        runtimes=[RemoteRuntime(["@line"], machine="a"), "monty"],
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
        assert said.decision is not None
        assert "_ShortOnB on machine b" in said.decision.reason
        assert "_OnA on machine a" in said.decision.reason
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_machine_a_command_runs_on():
    ws = _workspace(_ShortOnB())
    try:
        said = await ws.explain("hostname; hostname -s; ls")
        commands = [node for node in _commands(said.node) if node.command]
        assert [(c.command, c.runtime, c.machine) for c in commands] == [
            ("hostname", "remote:a", "box:a"),
            ("hostname", "remote:a", "box:b"),
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
        runtimes=[RemoteRuntime(["nohup", "hostname"], machine="a")],
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
        assert wrapper.decision == run.decision
        assert wrapper.stderr == await run.stderr_str()
        echo = next(n for n in _commands(said.node) if n.command == "echo")
        assert (echo.outcome, echo.exit_code) == (Outcome.ALLOW, 0)
    finally:
        await ws.close()


class _Answers(Policy):
    def __init__(self, command, answer):
        self._command = command
        self._answer = answer

    def pre_command(self, ctx):
        return self._answer if ctx.command == self._command else None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("command", "answer", "outcome"),
    [
        ("nohup", Ask("sign-off"), Outcome.ASK),
        ("hostname", Ask("sign-off"), Outcome.ASK),
        ("nohup", Deny("no"), Outcome.DENY),
    ],
)
async def test_explain_keeps_what_stops_a_wrapper_before_its_routes(
    command, answer, outcome
):
    ws = _workspace(_Answers(command, answer), _WrapperApart())
    try:
        said = await ws.explain("nohup hostname")
        nodes = {n.command: n for n in _commands(said.node)}
        run = await ws.shell("nohup hostname")
        assert nodes[command].outcome is outcome
        assert (
            nodes[command].decision.reason
            == run.decision.reason
            == answer.reason
        )
        assert nodes["nohup"].outcome is (
            outcome if command == "nohup" else Outcome.ALLOW
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_refuses_disagreeing_routes_once_an_approval_is_given():
    ws = _workspace(_Answers("nohup", Ask("sign-off")), _WrapperApart())
    try:
        first = await ws.shell("nohup hostname")
        await ws.decisions.answer(
            first.decision.ask_id, Outcome.ALLOW, Scope.SESSION
        )
        said = await ws.explain("nohup hostname")
        wrapper = next(n for n in _commands(said.node) if n.command == "nohup")
        run = await ws.shell("nohup hostname")
        assert (wrapper.outcome, wrapper.exit_code) == (Outcome.DENY, 126)
        assert wrapper.decision == run.decision
    finally:
        await ws.close()


def _commands(node):
    for child in getattr(node, "children", ()):
        if getattr(child, "type", "") == "command":
            yield child
        yield from _commands(child)


class _MontyOnB(Policy):
    def pre_execute(self, ctx):
        return Route("monty", machine="b")


def _with_monty(*policies: Policy) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[
            RemoteRuntime(["hostname"], machine="a"),
            "monty",
            "workspace",
        ],
        policies=list(policies),
    )


@pytest.mark.asyncio
async def test_a_route_refuses_a_machine_its_runtime_does_not_run_on():
    refusal = "runtime 'monty' runs on the workspace's machine"
    ws = _with_monty(_MontyOnB())
    try:
        with pytest.raises(RouteError, match=refusal):
            await ws.shell("hostname")
    finally:
        await ws.close()
    ws = _with_monty()
    try:
        with pytest.raises(RouteError, match=refusal):
            await ws.shell("hostname", runtime="monty", machine="b")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_route_to_a_machine_needs_a_remote_runtime():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"b": _Box("b")},
        runtimes=["monty", "workspace"],
        policies=[_OnB()],
    )
    try:
        with pytest.raises(RouteError, match="machine 'b' takes the remote"):
            await ws.shell("echo hi")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_command_routed_to_a_local_runtime_keeps_the_lines_machine():
    ws = _with_monty(_HostnameOnMonty())
    try:
        said = await ws.shell("hostname", machine="b")
        assert (said.exit_code, said.stdout) == (0, b"b\n")
    finally:
        await ws.close()


class _HostnameOnMontyOnB(Policy):
    def pre_command(self, ctx):
        if ctx.command == "hostname":
            return Route("monty", machine="b")
        return None


@pytest.mark.asyncio
async def test_explain_refuses_a_command_route_to_a_machine_as_a_route_error():
    ws = _with_monty(_HostnameOnMontyOnB())
    try:
        with pytest.raises(RouteError, match="runs on the workspace's"):
            await ws.explain("hostname")
    finally:
        await ws.close()


# Each remote entry is named for its machine, so a workspace holds one per
# machine and each program goes to the entry that captures it.
@pytest.mark.asyncio
async def test_each_machine_takes_a_remote_entry_of_its_own():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b")},
        runtimes=[
            RemoteRuntime(["python3"], machine="a"),
            RemoteRuntime(["node"], machine="b"),
        ],
    )
    try:
        assert [r.name for r in ws.runtimes()] == [
            "remote:a",
            "remote:b",
            "workspace",
        ]
        said = await ws.shell("python3 x.py; node x.js; python3 x.py | node")
        assert said.stdout == b"a\nb\nb\n"
        said = await ws.shell("node x.js", runtime="remote:b")
        assert said.stdout == b"b\n"
        with pytest.raises(ValueError, match="ambiguous runtime: 'remote'"):
            await ws.shell("node x.js", runtime="remote")
    finally:
        await ws.close()


# A program two remote entries both capture goes to the first listed, on
# every line, after an entry is added, and to the next once it is removed.
@pytest.mark.asyncio
async def test_the_first_remote_entry_keeps_what_both_capture():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": _Box("a"), "b": _Box("b"), "c": _Box("c")},
        runtimes=[RemoteRuntime(machine="a"), RemoteRuntime(machine="b")],
    )
    try:
        assert (await ws.shell("train; train")).stdout == b"a\na\n"
        ws.add_runtime(RemoteRuntime(machine="c"))
        assert [r.name for r in ws.runtimes()] == [
            "remote:a",
            "remote:b",
            "remote:c",
            "workspace",
        ]
        assert (await ws.shell("train")).stdout == b"a\n"
        await ws.remove_runtime("remote:a")
        assert (await ws.shell("train")).stdout == b"b\n"
    finally:
        await ws.close()


# A stage's one program records its own words, expanded, as bash's exec
# does, so each pass of a loop names what it ran.
@pytest.mark.asyncio
async def test_a_loop_records_each_programs_expanded_words():
    ws = _workspace()
    try:
        said = await ws.shell("for i in 1 2; do hostname -s$i | cat; done")
        assert said.stdout == b"a\na\n"
        commands = [p.command for p in await ws.processes()]
        assert [c for c in commands if c.startswith("hostname")] == [
            "hostname -s1",
            "hostname -s2",
        ]
    finally:
        await ws.close()


# What a program reads from another names the process writing it: the
# stage before it as its stdin, while it reads its stage's pipe, a `<( )`
# by the descriptor it got, a `$( )` as its arguments.
@pytest.mark.asyncio
async def test_a_program_names_the_processes_it_reads_from():
    ws = _workspace()
    try:
        read = {}
        for line, reader in (
            ("hostname | hostname", "hostname"),
            ("hostname <(hostname); true", "hostname /dev/fd/63"),
            ('hostname "$(hostname)"; true', "hostname a"),
            (
                'f() { hostname "$1"; }; f <(hostname); true',
                "hostname /dev/fd/63",
            ),
            ("hostname | { hostname; true; }", "hostname"),
            ("hostname | { hostname < /dev/null; true; }", "hostname"),
        ):
            assert (await ws.shell(line)).stdout == b"a\n"
            ran = {p.pid: p for p in await ws.processes()}
            [program] = [
                p
                for p in ran.values()
                if p.command == reader and p.runtime is not None
            ][-1:]
            read[line] = (
                ran[program.stdin].command if program.stdin else None,
                {fd: ran[pid].command for fd, pid in program.fd.items()},
                [ran[pid].command for pid in program.argv],
            )
        assert read == {
            "hostname | hostname": ("hostname", {}, []),
            "hostname <(hostname); true": (None, {63: "hostname"}, []),
            'hostname "$(hostname)"; true': (None, {}, ["hostname"]),
            'f() { hostname "$1"; }; f <(hostname); true': (
                None,
                {63: "hostname"},
                [],
            ),
            "hostname | { hostname; true; }": ("hostname", {}, []),
            "hostname | { hostname < /dev/null; true; }": (None, {}, []),
        }
    finally:
        await ws.close()


# A forked shell's last program runs in the shell's place, as bash execs
# it there: a subshell's and a substitution's leave no shell between it
# and the line, a line's own stays its session's `$$`.
@pytest.mark.asyncio
async def test_a_forked_shells_last_program_runs_as_the_shell():
    ws = _workspace()
    try:
        for line in ("(true; hostname); true", "x=$(hostname); echo $x"):
            assert (await ws.shell(line)).stdout == b"a\n"
        shell = int((await ws.shell("echo $$")).stdout)
        programs = [
            p
            for p in await ws.processes()
            if p.runtime is not None and p.line is not None
        ]
        assert [(p.command, p.parent) for p in programs] == [
            ("hostname", shell),
            ("hostname", shell),
        ]
        await ws.shell("hostname")
        [line] = [p for p in await ws.processes() if p.command == "hostname"][
            -1:
        ]
        assert line.parent == shell
    finally:
        await ws.close()
