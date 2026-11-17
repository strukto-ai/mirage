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

from mirage import Policy
from mirage.execution.types import MachineName
from mirage.io.types import materialize
from mirage.machine.handle import MachineHandle
from mirage.policy import CommandExplanation, Deny, Route, ShellNode
from mirage.policy.types import AdmissionRules, CommandRule, Outcome, Scope
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS, IN_PROCESS
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.types import RunResult
from mirage.shell.parse import parse, syntax_refusal
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.node.command_dispatch import parser_aliases


def _ws() -> Workspace:
    return Workspace(
        {"/data": (RAMVFS(), MountMode.WRITE)}, mode=MountMode.WRITE
    )


@pytest.mark.asyncio
async def test_rm_f_of_the_empty_name_removes_nothing():
    # rm -f silences the empty name's ENOENT, and the bookkeeping after a
    # clean rm used to purge the node table under its `virtual`, the
    # working directory, taking every link there with it.
    ws = _ws()
    await ws.shell("mkdir -p /data/d; echo x > /data/d/f; ln -s f /data/d/l")
    r = await ws.shell("cd /data/d && rm -rf ''")
    assert r.exit_code == 0
    assert ws.namespace.is_link("/data/d/l")
    assert (await ws.shell("cat /data/d/f")).stdout == b"x\n"


@pytest.mark.asyncio
async def test_a_loop_fails_its_operand_not_the_line():
    ws = _ws()
    await ws.shell(
        "echo a > /data/a.txt; echo b > /data/b.txt; "
        "ln -s /data/l2 /data/l1; ln -s /data/l1 /data/l2"
    )
    r = await ws.shell("cat /data/a.txt /data/l1 /data/b.txt")
    assert r.exit_code == 1
    assert r.stdout == b"a\nb\n"
    assert r.stderr == (b"cat: /data/l1: Too many levels of symbolic links\n")


class ShellsOut(LanguageRuntime):
    name = "shellsout"
    language = "python"

    def __init__(self) -> None:
        super().__init__(captures=["python3"])

    async def interpret(
        self, engine, program, ctx, output, errors
    ) -> RunResult:
        nested = await ctx.shell("printenv TOKEN")
        await output(await materialize(nested.stdout))
        return RunResult(exit_code=0)


# A run starts as its output is read, after dispatch returned, and the
# lines it shells out still run under its prefix assignment.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["TOKEN=one python3 -c x", "TOKEN=one python3 -c x | cat"]
)
async def test_a_lazy_run_shells_out_under_its_prefix(line):
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[ShellsOut()]
    )
    try:
        assert (await ws.shell(line)).stdout == b"one\n"
        after = await ws.shell('echo "[$TOKEN]"')
        assert after.stdout == b"[]\n"
    finally:
        await ws.close()


@pytest.mark.parametrize(
    ("line", "own", "stderr"),
    [
        (
            "echo F; fi",
            {"fi": (0, 10)},
            "bash: -c: line 1: syntax error near unexpected token `fi'\n"
            "bash: -c: line 1: `echo F; fi'\n",
        ),
        ("echo F; fi", {"fi": (0, 7)}, None),
        ("echo C; fi echo F", {"c": (0, 11), "fi": (11, 17)}, None),
        (
            "echo C; echo F; fi",
            {"c": (0, 8), "fi": (8, 18)},
            "bash: -c: line 1: syntax error near unexpected token `fi'\n"
            "bash: -c: line 1: `echo C; echo F; fi'\n",
        ),
        (
            "echo F \\\n; fi",
            {"fi": (0, 13)},
            "bash: -c: line 2: syntax error near unexpected token `fi'\n"
            "bash: -c: line 2: `; fi'\n",
        ),
        ("echo F \\\n; fi", {"fi": (0, 10)}, None),
    ],
)
def test_an_alias_name_is_reserved_inside_its_own_text(line, own, stderr):
    # Pinned against bash 5.2.37: a name stays reserved only inside the
    # text its alias put there, a trailing blank's chained one included.
    # Spans are in the line as typed, which a continuation shifts.
    owners = tuple(
        frozenset(
            name for name, (start, end) in own.items() if start <= at < end
        )
        for at in range(len(line))
    )
    aliases = parser_aliases(
        line, frozenset(own), owners, tuple(range(len(line) + 1))
    )
    io = syntax_refusal(parse(line, aliases), "bash: -c: ", 1, True)
    assert (io and io.stderr) == (stderr and stderr.encode())


class Box(Runtime, ProcessExecutorMixin):
    name = "box"
    captures = (EXTERNAL_COMMANDS,)

    def __init__(self) -> None:
        super().__init__()
        self.ran: list[list[str]] = []

    @property
    def machine(self) -> MachineName:
        return MachineName("ssh", self.name)

    async def run_process(
        self, engine, paths, texts, ctx, output, errors
    ) -> RunResult:
        self.ran.append(list(texts))
        return RunResult(exit_code=0)


WRAPPERS = ["nohup", "nice", "stdbuf", "setsid", "ionice"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "bare"),
    [
        ("nohup tool -c x", "tool -c x"),
        ("nice -n 5 tool -c x", "tool -c x"),
        ("stdbuf -oL tool -c x", "tool -c x"),
        ("setsid -w tool -c x", "tool -c x"),
        ("ionice -c 3 tool -c x", "tool -c x"),
        ("nohup nice tool -c x", "tool -c x"),
        ("nohup tool -c x & wait $!", "tool -c x & wait $!"),
        ("nohup time tool -c x", "time tool -c x"),
        ("nohup nice time -p tool -c x", "time -p tool -c x"),
        ("nohup time env tool -c x", "time env tool -c x"),
    ],
)
async def test_a_wrapper_runs_no_program_the_allow_list_leaves_out(line, bare):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {"allow": [*WRAPPERS, "wait", "time", "env"]}
            },
        )
        alone = await ws.shell(bare, session_id="s")
        r = await ws.shell(line, session_id="s")
        assert alone.exit_code == r.exit_code == 126
        assert r.stderr is not None
        assert b"tool: Permission denied\n" in r.stderr
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_outside_wrapper_admits_every_wrapper_it_runs():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s", profile={"commands": {"allow": ["nohup", "python3"]}}
        )
        r = await ws.shell("nohup nice python3 -c x", session_id="s")
        assert r.exit_code == 126
        assert r.stderr is not None and r.stderr.startswith(b"nice: ")
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "nohup tool -c x",
        "nohup -- tool -c x",
        "nice --ad 5 tool -c x",
    ],
)
async def test_a_wrapper_hands_a_machine_its_words_before_a_listed_program(
    line,
):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s", profile={"commands": {"allow": ["nohup", "nice", "tool"]}}
        )
        r = await ws.shell(line, session_id="s")
        assert r.exit_code == 0
        assert box.ran == [line.split()]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_answers_its_own_help():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        r = await ws.shell("nohup --help")
        assert r.exit_code == 0
        assert "Usage: nohup" in await r.stdout_str()
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_outside_wrapper_reads_its_program_s_operands():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "deny": [
                        {"reason": "secret", "paths": ["/data/secret.py"]}
                    ]
                }
            },
        )
        bare = await ws.shell("cd /data && python3 secret.py", session_id="s")
        r = await ws.shell(
            "cd /data && nohup python3 secret.py", session_id="s"
        )
        assert bare.exit_code != 0 and bare.stderr
        assert (r.exit_code, r.stderr) == (bare.exit_code, bare.stderr)
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_outside_wrapper_s_program_is_asked_once():
    # The pass asks about the program where it stands under the wrapper,
    # and the gate finds that answer there rather than asking again.
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {"ask": [{"reason": "nod", "commands": ["tool"]}]}
            },
        )
        line = "nohup tool -c x"
        held = await ws.shell(line, session_id="s")
        assert held.exit_code == 126
        (pending,) = ws.decisions.pending()
        await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert box.ran == [["nohup", "tool", "-c", "x"]]
        assert ws.decisions.pending() == ()
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("profile", "refused"),
    [
        ({"commands": {"allow": ["nohup"]}}, True),
        ({"commands": {"deny": [{"reason": "r", "commands": ["rm"]}]}}, False),
        ({}, False),
    ],
)
async def test_an_outside_wrapper_runs_a_path_only_without_an_allow_list(
    profile, refused
):
    # The box resolves a path on its own disk, which the gate cannot read,
    # so an allow list, which names only what it can read, refuses it.
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session("s", profile=profile)
        r = await ws.shell("nohup /opt/bin/env python3 -c x", session_id="s")
        if refused:
            assert (r.exit_code, r.stderr) == (
                126,
                b"/opt/bin/env: Permission denied\n",
            )
            assert box.ran == []
        else:
            assert r.exit_code == 0
            assert box.ran == [["nohup", "/opt/bin/env", "python3", "-c", "x"]]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("setup", "line", "bare"),
    [
        (
            "",
            "nohup time env --split-string='tool -c x'",
            "time env --split-string='tool -c x'",
        ),
        ("", "nohup time env -S 'tool -c x'", "time env -S 'tool -c x'"),
        (
            "pip() { echo harmless; }",
            "nohup time pip --version",
            "time pip --version",
        ),
    ],
)
async def test_a_wrapper_s_program_answers_as_it_does_bare(setup, line, bare):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session(
            "s",
            profile={"commands": {"allow": ["nohup", "time", "env", "echo"]}},
        )
        if setup:
            await ws.shell(setup, session_id="s")
        alone = await ws.shell(bare, session_id="s")
        r = await ws.shell(line, session_id="s")
        assert (r.exit_code, r.stdout) == (alone.exit_code, alone.stdout)
        assert box.ran == []
    finally:
        await ws.close()


class Named(MachineHandle):
    provider = "box"

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        await output(f"{self.name}\n".encode())
        return RunResult(exit_code=0)


class HostnameOn(Policy):
    def __init__(self, machine: str) -> None:
        self.machine = machine

    def pre_command(self, ctx):
        return (
            Route(machine=self.machine) if ctx.command == "hostname" else None
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("machine", ["a", "b"])
async def test_an_outside_wrapper_runs_where_its_program_is_routed(machine):
    # The wrapper goes with its program, so a route answering for the program
    # places them both, as it places the program run alone.
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "a": Named("a", {"captures": ["hostname"]}),
            "b": Named("b", {"captures": ["hostname"]}),
        },
        policies=[HostnameOn(machine)],
    )
    try:
        out = f"{machine}\n".encode()
        assert (await ws.shell("hostname")).stdout == out
        r = await ws.shell("nohup hostname")
        assert (r.exit_code, r.stdout) == (0, out)
    finally:
        await ws.close()


class Routes(Policy):
    def __init__(self, routes: dict[str, Route]) -> None:
        self.routes = routes

    def pre_command(self, ctx):
        return self.routes.get(ctx.command)


TWO_TOOLS = r"nohup find / -maxdepth 0 -exec tool_a {} \; -exec tool_b {} \;"


def _routed(routes: dict[str, Route]) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "a": Named("a", {"captures": ["find", "hostname"]}),
            "b": Named("b", {"captures": ["find", "hostname"]}),
        },
        policies=[Routes(routes)],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("routes", "line", "out"),
    [
        (
            {"tool_a": Route(machine="a"), "tool_b": Route(machine="b")},
            TWO_TOOLS,
            b"a\n",
        ),
        (
            {"tool_a": Route(machine="b"), "tool_b": Route(machine="b")},
            TWO_TOOLS,
            b"a\n",
        ),
        (
            {"nohup": Route(machine="a"), "hostname": Route(machine="b")},
            "nohup hostname",
            b"b\n",
        ),
        ({"nice": Route(machine="b")}, "nohup nice hostname", b"b\n"),
        ({"nohup": Route(machine="b")}, "nohup hostname", b"b\n"),
        ({}, "nohup hostname", b"a\n"),
    ],
)
async def test_a_wrapper_s_program_runs_where_its_routes_place_it(
    routes, line, out
):
    # Mirage runs the wrapper and hands its route to what it runs, where the
    # program's own route wins; a machine's find runs the -exec programs
    # itself, so their routes move nothing.
    ws = _routed(routes)
    try:
        r = await ws.shell(line)
        assert (r.exit_code, r.stdout) == (0, out)
    finally:
        await ws.close()


class NoPython(Policy):
    def pre_command(self, ctx):
        return Deny("no python") if ctx.command == "python3" else None


SPELLED = [
    "nice /usr/bin/python3 -c 1",
    "nohup /usr/bin/python3 -c 1",
    "setsid /usr/bin/python3 -c 1",
    "nice nohup /usr/bin/python3 -c 1",
    "cd /usr/bin && nice ./python3 -c 1",
    "nohup /usr/bin/env python3 -c 1",
    "ln -s /usr/bin/python3 /py && nice /py -c 1",
]

NO_PYTHON_PROFILES = {
    "default": {
        "commands": {"deny": [{"reason": "no", "commands": ["python3"]}]}
    }
}


def _explained(
    node: ShellNode | CommandExplanation,
) -> list[tuple[str, int, str]]:
    own = (
        [(node.command, node.exit_code, node.machine)]
        if isinstance(node, CommandExplanation)
        else []
    )
    return own + [e for child in node.children for e in _explained(child)]


def _spelled(**kwargs) -> Workspace:
    return Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "m": {"provider": "in_process", "runtime": "monty"},
            "c": Named("c", {"captures": ["python3"]}),
            "b": Named("b", {"captures": [EXTERNAL_COMMANDS]}),
        },
        **kwargs,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("line", SPELLED)
@pytest.mark.parametrize(
    "denies", [{"policies": [NoPython()]}, {"profiles": NO_PYTHON_PROFILES}]
)
async def test_a_wrapper_refuses_a_program_spelled_by_its_path(line, denies):
    # The plain path runs /usr/bin/python3 as python3, so a deny on the
    # name holds under a wrapper however the program is spelled.
    ws = _spelled(**denies)
    try:
        bare = await ws.shell("python3 -c 1")
        r = await ws.shell(line)
        assert bare.exit_code == 126
        assert (r.exit_code, r.stderr) == (126, bare.stderr)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", SPELLED)
async def test_a_wrapper_goes_where_a_path_spelled_program_is_routed(line):
    ws = _spelled(policies=[Routes({"python3": Route(machine="c")})])
    try:
        assert (await ws.shell("/usr/bin/python3 -c 1")).stdout == b"c\n"
        r = await ws.shell(line)
        said = await ws.explain(line)
        assert (r.exit_code, r.stdout) == (0, b"c\n")
        assert "b" not in [m for _, _, m in _explained(said.node)]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_s_route_yields_to_its_path_spelled_program_s():
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "c": Named("c", {"captures": ["python3"]}),
            "b": Named("b", {"captures": [EXTERNAL_COMMANDS]}),
        },
        policies=[
            Routes({"nice": Route(machine="b"), "python3": Route(machine="c")})
        ],
    )
    try:
        bare = await ws.explain("nice python3 -c 1")
        said = await ws.explain("nice /usr/bin/python3 -c 1")
        ran = await ws.shell("nice /usr/bin/python3 -c 1")
        assert (ran.exit_code, ran.stdout) == (0, b"c\n")
        assert _explained(said.node)[-1] == _explained(bare.node)[-1]
        assert _explained(said.node)[-1][2] == "c"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_leaves_a_path_the_view_does_not_list_to_the_machine():
    # Only a listed /usr/bin file is a program; any other path is the
    # machine's own file under a wrapper as on the plain path, which only an
    # allow list refuses.
    deny = {"deny": [{"reason": "no", "commands": ["nosuch"]}]}
    ws = _spelled(profiles={"default": {"commands": deny}})
    try:
        bare = await ws.shell("/usr/bin/nosuch -c 1")
        r = await ws.shell("nice /usr/bin/nosuch -c 1")
        assert (r.exit_code, r.stdout) == (bare.exit_code, bare.stdout)
        assert bare.stdout == b"b\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["/usr/bin/python3 -c 1", "nohup /usr/bin/python3 -c 1"]
)
async def test_a_path_spelled_program_is_asked_once(line):
    ws = _spelled(
        profiles={
            "default": {
                "commands": {
                    "ask": [{"reason": "nod", "commands": ["python3"]}]
                }
            }
        }
    )
    try:
        held = await ws.shell(line)
        assert held.exit_code == 126
        (pending,) = ws.decisions.pending()
        await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
        ran = await ws.shell(line)
        assert ran.exit_code == 0
        assert ws.decisions.pending() == ()
    finally:
        await ws.close()


class GccBox(Box):
    captures = ("gcc",)


@pytest.mark.asyncio
async def test_a_wrapper_hands_its_runtime_the_program_a_path_names():
    # The plain path runs a /usr/bin program by its name, so a wrapper hands
    # its runtime the name too: a workspace link means nothing to the host.
    box = GccBox()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        await ws.shell("ln -s /usr/bin/gcc /data/tool")
        await ws.shell("/data/tool x.c")
        r = await ws.shell("nice /data/tool x.c")
        assert r.exit_code == 0
        assert box.ran == [["gcc", "x.c"], ["nice", "gcc", "x.c"]]
    finally:
        await ws.close()


class InProcessBox(Box):
    @property
    def machine(self) -> MachineName:
        return MachineName(IN_PROCESS, self.name)


class InProcessGccBox(InProcessBox):
    captures = ("gcc",)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "nice gcc x.c",
        "nohup gcc x.c",
        "setsid gcc x.c",
        "nice -n 5 nohup gcc x.c",
        "nice /usr/bin/gcc x.c",
    ],
)
async def test_a_wrapper_over_an_in_process_machines_program_is_dropped(line):
    box = InProcessGccBox()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        r = await ws.shell(line)
        assert r.exit_code == 0
        assert box.ran == [["gcc", "x.c"]]
    finally:
        await ws.close()


class RemoteGccBox(Box):
    name = "remote"
    captures = ("gcc",)


@pytest.mark.asyncio
async def test_a_wrapper_goes_with_its_program_routed_off_an_in_process_machine():
    near, far = InProcessGccBox(), RemoteGccBox()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[near, far],
        policies=[Routes({"gcc": Route(machine="remote")})],
    )
    try:
        r = await ws.shell("nohup gcc x.c")
        assert r.exit_code == 0
        assert (near.ran, far.ran) == ([], [["nohup", "gcc", "x.c"]])
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_over_an_in_process_external_program_is_dropped():
    box = InProcessBox()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        r = await ws.shell("nohup native-tool a")
        assert r.exit_code == 0
        assert box.ran == [["native-tool", "a"]]
    finally:
        await ws.close()


class DashBox(Box):
    captures = ("--help",)


@pytest.mark.asyncio
async def test_a_wrapper_keeps_the_path_of_a_program_named_like_an_option():
    box = DashBox()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        r = await ws.shell("nice /usr/bin/--help")
        assert r.exit_code == 0
        assert box.ran == [["nice", "--", "--help"]]
    finally:
        await ws.close()


class OtherBox(Box):
    name = "other"
    captures = ("hostname",)


class HostnameTo(Policy):
    def __init__(self, runtime: str) -> None:
        self.runtime = runtime

    def pre_command(self, ctx):
        return Route(self.runtime) if ctx.command == "hostname" else None


@pytest.mark.asyncio
async def test_a_routed_wrapper_reaches_the_runtime_with_its_words():
    box, other = Box(), OtherBox()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[box, other],
        policies=[HostnameTo("other")],
    )
    try:
        r = await ws.shell("nohup nice -n 5 hostname -s")
        assert r.exit_code == 0
        assert other.ran == [["nohup", "nice", "-n", "5", "hostname", "-s"]]
        assert box.ran == []
    finally:
        await ws.close()


class PythonOnMonty(Policy):
    def pre_command(self, ctx):
        return Route("monty") if ctx.command == "python3" else None


@pytest.mark.asyncio
async def test_a_route_into_mirage_runs_the_wrapper_s_program_there():
    box = Box()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[box, MontyRuntime()],
        policies=[PythonOnMonty()],
    )
    try:
        r = await ws.shell("nohup python3 -c 'print(1)'")
        assert (r.exit_code, r.stdout) == (0, b"1\n")
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("profile", "refused"),
    [
        ({"commands": {"allow": ["echo"]}}, True),
        ({"commands": {"deny": [{"reason": "r", "commands": ["rm"]}]}}, False),
        ({}, False),
    ],
)
async def test_an_absent_path_goes_to_the_external_runtime(profile, refused):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        ws.create_session("s", profile=profile)
        r = await ws.shell("/opt/tool a", session_id="s")
        if refused:
            assert (r.exit_code, r.stderr) == (
                126,
                b"/opt/tool: Permission denied\n",
            )
            assert box.ran == []
        else:
            assert r.exit_code == 0
            assert box.ran == [["/opt/tool", "a"]]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_path_mirage_holds_runs_in_mirage():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        await ws.shell("echo 'echo hi' > /data/s.sh")
        r = await ws.shell("/data/s.sh")
        assert (r.exit_code, r.stdout) == (0, b"hi\n")
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_relative_path_stays_the_shell_s_to_answer():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[box])
    try:
        r = await ws.shell("./tool a")
        assert r.exit_code == 127
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_absent_path_is_the_shell_s_without_an_external_runtime():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[])
    try:
        r = await ws.shell("/opt/tool a")
        assert r.exit_code == 127
        assert b"No such file or directory" in r.stderr
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, stdout",
    [
        ("timeout() { echo fn; }; timeout 1 echo x", b"fn\n"),
        ("env() { echo fn; }; env true", b"fn\n"),
        ("sleep() { echo fn; }; sleep 5", b"fn\n"),
        ("echo() { builtin echo fn:$1; }; echo hi", b"fn:hi\n"),
        ("ps() { echo fn; }; ps", b"fn\n"),
        ("ln() { echo fn; }; ln -s a b", b"fn\n"),
        ("chmod() { echo fn; }; chmod 644 x", b"fn\n"),
        ("timeout() { echo fn; }; timeout --help", b"fn\n"),
        ("timeout() { echo fn; }; command timeout 1 echo x", b"x\n"),
        ("sleep() { echo fn; }; timeout 1 sleep 0", b""),
        (
            "echo x > /data/f; chmod() { echo fn; }; "
            "timeout 1 chmod 600 /data/f; stat -c %a /data/f",
            b"600\n",
        ),
        (
            "echo x > /data/f; cat() { echo fn; }; xargs cat <<< /data/f",
            b"x\n",
        ),
        ("cd() { echo fn; }; cd /data; pwd", b"/data\n"),
    ],
)
async def test_a_function_shadows_a_builtin_that_is_a_program(line, stdout):
    r = await _ws().shell(line)
    assert (await materialize(r.stdout), r.exit_code) == (stdout, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "function, line",
    [
        ("timeout", "timeout 1 rm /data/f"),
        ("env", "env rm /data/f"),
        ("xargs", "echo /data/f | xargs rm"),
        ("sh", "sh -c 'rm /data/f'"),
    ],
)
async def test_a_function_runs_no_words_the_builtin_would_have_run(
    function, line
):
    ws = _ws()
    ws.create_session("s")
    await ws.shell(f"echo x > /data/f; {function}() {{ :; }}", session_id="s")
    ws.get_session("s").commands = AdmissionRules(
        deny=(CommandRule(reason="no rm", commands=("rm",)),)
    )
    r = await ws.shell(line, session_id="s")
    assert r.exit_code == 0
    refused = await ws.shell("command timeout 1 rm /data/f", session_id="s")
    assert refused.exit_code == 126
