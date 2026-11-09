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
from mirage.io.types import materialize
from mirage.machine.handle import MachineHandle
from mirage.policy import Route
from mirage.policy.types import Outcome, Scope
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.machine import MachineRuntime
from mirage.runtime.mixin import ProcessExecutorMixin
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
        self, engine, program, ctx, output=None, errors=None
    ) -> RunResult:
        nested = await ctx.shell("printenv TOKEN")
        return RunResult(
            stdout=await materialize(nested.stdout), stderr=None, exit_code=0
        )


# A run starts as its output is read, after dispatch returned, and the
# lines it shells out still run under its prefix assignment.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["TOKEN=one python3 -c x", "TOKEN=one python3 -c x | cat"]
)
async def test_a_lazy_run_shells_out_under_its_prefix(line):
    ws = Workspace(
        {"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[ShellsOut()]
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

    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        self.ran.append(list(texts))
        return RunResult(stdout=b"", stderr=None, exit_code=0)


WRAPPERS = ["nohup", "nice", "stdbuf", "setsid", "ionice"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("line", "refused"),
    [
        ("nohup python3 -c x", "python3"),
        ("nice -n 5 python3 -c x", "python3"),
        ("stdbuf -oL python3 -c x", "python3"),
        ("setsid -w python3 -c x", "python3"),
        ("ionice -c 3 python3 -c x", "python3"),
        ("nohup nice python3 -c x", "python3"),
        ("nohup python3 -c x & wait $!", "python3"),
        ("nohup time python3 -c x", "python3"),
        ("nohup nice time -p python3 -c x", "python3"),
        ("nohup time env python3 -c x", "python3"),
    ],
)
async def test_an_outside_wrapper_runs_no_program_the_allow_list_leaves_out(
    line, refused
):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {"allow": [*WRAPPERS, "wait", "time", "env"]}
            },
        )
        bare = await ws.shell(f"{refused} -c x", session_id="s")
        r = await ws.shell(line, session_id="s")
        assert bare.exit_code == 126
        assert (r.exit_code, r.stderr) == (126, bare.stderr)
        assert box.ran == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_outside_wrapper_admits_every_wrapper_it_runs():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
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
        "nohup python3 -c x",
        "nohup --help",
        "nohup -- python3 -c x",
        "nice --ad 5 python3 -c x",
    ],
)
async def test_an_outside_wrapper_runs_a_listed_program(line):
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
    try:
        ws.create_session(
            "s", profile={"commands": {"allow": ["nohup", "nice", "python3"]}}
        )
        r = await ws.shell(line, session_id="s")
        assert r.exit_code == 0
        assert box.ran == [line.split()]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_outside_wrapper_reads_its_program_s_operands():
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
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
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
    try:
        ws.create_session(
            "s",
            profile={
                "commands": {
                    "ask": [{"reason": "nod", "commands": ["python3"]}]
                }
            },
        )
        line = "nohup python3 -c x"
        held = await ws.shell(line, session_id="s")
        assert held.exit_code == 126
        (pending,) = ws.decisions.pending()
        await ws.decisions.answer(pending.id, Outcome.ALLOW, Scope.ONCE)
        ran = await ws.shell(line, session_id="s")
        assert ran.exit_code == 0
        assert box.ran == [["nohup", "python3", "-c", "x"]]
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
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
    try:
        ws.create_session("s", profile=profile)
        r = await ws.shell("nohup /usr/bin/env python3 -c x", session_id="s")
        if refused:
            assert (r.exit_code, r.stderr) == (
                126,
                b"/usr/bin/env: Permission denied\n",
            )
            assert box.ran == []
        else:
            assert r.exit_code == 0
            assert box.ran == [["nohup", "/usr/bin/env", "python3", "-c", "x"]]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("setup", "line", "refused"),
    [
        ("", "nohup time env --split-string='python3 -c x'", "env"),
        ("", "nohup time env -S 'python3 -c x'", "env"),
        ("pip() { echo harmless; }", "nohup time pip --version", "pip"),
    ],
)
async def test_an_outside_wrapper_s_program_is_what_the_machine_runs(
    setup, line, refused
):
    # GNU env splits -S into a command line the gate cannot read, and the
    # machine runs its own pip, not the session's function of that name.
    box = Box()
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=[box])
    try:
        ws.create_session(
            "s",
            profile={"commands": {"allow": ["nohup", "time", "env", "echo"]}},
        )
        if setup:
            await ws.shell(setup, session_id="s")
        r = await ws.shell(line, session_id="s")
        assert (r.exit_code, r.stderr) == (
            126,
            f"{refused}: Permission denied\n".encode(),
        )
        assert box.ran == []
    finally:
        await ws.close()


class Named(MachineHandle):
    provider = "box"

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        return RunResult(
            stdout=f"{self.name}\n".encode(), stderr=None, exit_code=0
        )


class HostnameOn(Policy):
    def __init__(self, machine: str) -> None:
        self.machine = machine

    def pre_command(self, ctx):
        return (
            Route(machine=self.machine) if ctx.command == "hostname" else None
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(("machine", "out"), [("b", None), ("a", b"a\n")])
async def test_an_outside_wrapper_runs_where_its_program_is_routed(
    machine, out
):
    # The machine the wrapper runs on runs its program, so a route placing
    # the program on another one is refused, as in a line run whole.
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        machines={"a": Named("a"), "b": Named("b")},
        runtimes=[MachineRuntime(["hostname"], machine="a"), "workspace"],
        policies=[HostnameOn(machine)],
    )
    try:
        assert (await ws.shell("hostname")).stdout == f"{machine}\n".encode()
        r = await ws.shell("nohup hostname")
        if out is None:
            assert (r.exit_code, r.stdout) == (126, b"")
            assert r.refusal is not None
            assert r.refusal.reason.startswith(
                "HostnameOn routes hostname elsewhere"
            )
        else:
            assert (r.exit_code, r.stdout) == (0, out)
    finally:
        await ws.close()
