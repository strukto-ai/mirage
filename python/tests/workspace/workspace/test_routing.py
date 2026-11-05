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

import shlex

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.types import materialize
from mirage.policy import Policy, Route
from mirage.policy.types import CommandExplanation
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.sandbox import RemoteSandbox
from mirage.runtime.sandbox.constants import programs_probe
from mirage.runtime.types import Program, RunResult


class Monty(PythonRuntime):
    """A python engine that answers its own name."""

    name = "monty"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"monty\n", stderr=None, exit_code=0)


class Box(RemoteSandbox):
    """A box serving the workspace that holds ``holds`` of the
    interpreters and records every line it runs."""

    name = "box"

    def __init__(
        self,
        holds: str = "python3\n",
        serves: bool = True,
        captures: tuple[str, ...] | None = None,
    ) -> None:
        super().__init__(captures=captures)
        self.holds = holds
        self.serves = serves
        self.probes = 0
        self.lines: list[str] = []
        self.whole: list[str] = []
        self.argvs: list[tuple[str, ...]] = []

    def _serves_interpreters(self) -> bool:
        return self.serves

    @property
    def file_effects_dispatched(self) -> bool:
        return self.serves

    async def connect(self) -> None:
        return None

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        self.argvs.append(tuple(argv))
        if argv[:2] == ("/bin/sh", "-c"):
            self.whole.append(argv[4] if len(argv) > 4 else argv[2])
            return RunResult(stdout=b"box\n", stderr=None, exit_code=0)
        return await self.exec_line(shlex.join(argv), None, env, cwd)

    async def exec_line(self, line, stdin, env, cwd) -> RunResult:
        if line == programs_probe():
            self.probes += 1
            return RunResult(
                stdout=self.holds.encode(), stderr=None, exit_code=0
            )
        self.lines.append(line)
        return RunResult(stdout=b"box\n", stderr=None, exit_code=0)


def workspace(box: Box, **kwargs) -> Workspace:
    return Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, Monty(), "workspace"],
        **kwargs,
    )


async def out(ws: Workspace, line: str) -> bytes:
    return await materialize((await ws.shell(line)).stdout)


@pytest.mark.asyncio
async def test_the_first_interpreter_line_asks_the_box_once_and_runs_there():
    box = Box()
    ws = workspace(box)
    try:
        assert await out(ws, "echo hi") == b"hi\n"
        assert box.probes == 0
        await ws.shell("cd /ram")
        assert await out(ws, "python3 -c x") == b"box\n"
        assert await out(ws, "python3 -c y") == b"box\n"
        assert box.probes == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_interpreter_the_box_lacks_stays_on_its_language_runtime():
    box = Box(holds="")
    ws = workspace(box)
    try:
        assert await out(ws, "python3 -c x") == b"monty\n"
        assert await out(ws, "python3 -c y") == b"monty\n"
        assert box.probes == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_never_asks_the_box():
    box = Box()
    ws = workspace(box)
    try:
        await ws.explain("python3 -c x")
        assert box.probes == 0
    finally:
        await ws.close()


async def run(ws: Workspace, line: str) -> tuple[int, bytes, bytes]:
    io = await ws.shell(line)
    return (
        io.exit_code,
        await materialize(io.stdout),
        await materialize(io.stderr),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, whole, split",
    [
        ("cd /opt/app && make", ["cd /opt/app && make"], []),
        ("cat /tmp/a | gcc -", ["cat /tmp/a | gcc -"], []),
        ("gcc - > /tmp/out", ["gcc - > /tmp/out"], []),
        ("gcc /opt/x.c -o /opt/x", [], ["gcc /opt/x.c -o /opt/x"]),
        ("cd /ram && make", [], ["make"]),
        ("cd / && make", [], ["make"]),
        ("env cat /tmp/a | gcc -", ["env cat /tmp/a | gcc -"], []),
        ("timeout 5 gcc /opt/x.c", [], ["gcc /opt/x.c"]),
    ],
)
async def test_a_line_goes_whole_only_when_mirage_would_resolve_a_box_path(
    line, whole, split
):
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell(line)
        assert box.whole == whole
        assert box.lines == split
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_leaves_mirages_cwd_where_it_was():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell("cd /ram")
        await ws.shell("cd /opt/app && make")
        assert await out(ws, "pwd") == b"/ram\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_of_only_mirage_commands_stays_in_mirage():
    box = Box(holds="")
    ws = workspace(box)
    try:
        code, _, err = await run(ws, "cat /etc/os-release")
        assert code == 1
        assert b"No such file or directory" in err
        assert box.whole == [] and box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_file_mirage_wrote_on_its_own_root_is_mirages():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell("echo hi > /notes.txt")
        await ws.shell("cat /notes.txt | gcc -")
        assert box.whole == []
        await ws.shell("cat /absent.txt | gcc -")
        assert box.whole == ["cat /absent.txt | gcc -"]
    finally:
        await ws.close()


SANDBOX_OPT = "but the line runs in the sandbox for /opt"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line, stderr",
    [
        (
            "f() { :; }",
            "cd /opt && f; make",
            "cd: f runs in Mirage, but /opt is on the sandbox; "
            "run them on separate lines",
        ),
        (
            "shopt -s expand_aliases; alias ll=ls",
            "cd /opt && ll; make",
            "cd: ll is an alias, which the sandbox does not have, and /opt "
            "is on the sandbox",
        ),
        (
            "D=1",
            "cd /opt && echo $D; make",
            f"cd: D is not exported, {SANDBOX_OPT}",
        ),
        (
            "D=old",
            'D=$D; cd /opt && echo "$D"; make',
            f"D=$D;: D is not exported, {SANDBOX_OPT}",
        ),
        (
            "true",
            "cd /opt && echo $1; make",
            f"cd: $1 would read Mirage's value, {SANDBOX_OPT}",
        ),
        (
            "true",
            "cd /opt && echo $@; make",
            f"cd: $@ would read Mirage's value, {SANDBOX_OPT}",
        ),
        (
            "true",
            "cd /opt && echo $#; make",
            f"cd: $# would read Mirage's value, {SANDBOX_OPT}",
        ),
        (
            "true",
            "echo $? > /tmp/s; make",
            "echo: $? would read Mirage's value, but the line runs in the "
            "sandbox for /tmp/s",
        ),
        (
            "true",
            "echo $PIPESTATUS > /tmp/s; make",
            "echo: PIPESTATUS would read Mirage's value, but the line runs "
            "in the sandbox for /tmp/s",
        ),
        (
            "true",
            "cd /opt && make &",
            "cd: a line using the sandbox's /opt cannot run with & yet; drop "
            "the & or work in a workspace folder",
        ),
        (
            "true",
            "cd /opt && make; wait %1",
            "cd: wait runs in Mirage, but /opt is on the sandbox; "
            "run them on separate lines",
        ),
    ],
)
async def test_a_whole_line_that_would_change_meaning_is_refused(
    setup, line, stderr
):
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell(setup)
        assert await run(ws, line) == (1, b"", f"{stderr}\n".encode())
        assert box.whole == [] and box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, line",
    [
        ("export E=1", "cd /opt && echo $E; make"),
        ("true", "cd /opt && false; echo $?; make"),
        ("true", "X=1; cd /opt && echo $X; make"),
        ("true", "cd /opt && PATH=$PATH:/opt/bin make"),
        ("true", "cd /opt && echo $PATH $IFS; make"),
        ("export Z", "cd /opt && echo $Z; make"),
        ("D=old", "D=new; cd /opt && echo $D; make"),
        ("D=old", "export D=new; cd /opt && echo $D; make"),
    ],
)
async def test_a_whole_line_may_read_what_the_box_also_has(setup, line):
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell(setup)
        await ws.shell(line)
        assert box.whole == [line]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_route_policy_turns_the_default_off():
    box = Box(holds="")
    ws = workspace(box, route_policy=lambda ctx: None)
    try:
        code, _, _ = await run(ws, "cd /opt/app && make")
        assert code == 1
        assert box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_box_that_does_not_serve_the_workspace_gets_no_whole_lines():
    box = Box(holds="", serves=False)
    ws = workspace(box)
    try:
        await ws.shell("cd /opt/app && make")
        assert box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_interpreter_on_mirages_own_root_stays_on_its_runtime():
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("echo 'print(1)' > /hello.py")
        assert await out(ws, "python3 /hello.py") == b"monty\n"
        await ws.shell("cd /ram")
        assert await out(ws, "python3 -c x") == b"box\n"
        await ws.shell("cd /")
        assert await out(ws, "python3 -c x") == b"monty\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_runs_in_bash_and_a_line_capture_keeps_sh():
    box = Box(holds="")
    ws = workspace(box)
    lined = Box(holds="", captures=("@line",))
    by_line = workspace(lined)
    try:
        await ws.shell("cd /opt/app && make")
        argv = box.argvs[-1]
        assert argv[:2] == ("/bin/sh", "-c")
        assert 'set -- "$@" -c "$1"; shift 2; exec bash "$@"' in argv[2]
        assert argv[3:] == ("sh", "cd /opt/app && make", "box")
        await by_line.shell("cd /opt/app && make")
        assert lined.argvs[-1] == ("/bin/sh", "-c", "cd /opt/app && make")
    finally:
        await ws.close()
        await by_line.close()


BINARY = b"\x7fELF\x02\x01\x00\x00"


@pytest.mark.asyncio
async def test_a_binary_runs_in_the_sandbox_that_serves_the_workspace():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.vfs.write("/ram/t", BINARY)
        await ws.shell("cd /ram && ./t a")
        assert box.lines == ["./t a"]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "serves, mode", [(False, MountMode.EXEC), (True, MountMode.WRITE)]
)
async def test_a_binary_answers_126_without_a_serving_sandbox_or_exec(
    serves, mode
):
    box = Box(holds="", serves=serves)
    ws = Workspace(
        {"/ram": RAMVFS()}, mode=mode, runtimes=[box, Monty(), "workspace"]
    )
    try:
        await ws.vfs.write("/ram/t", BINARY)
        code, _, _ = await run(ws, "cd /ram && ./t a")
        assert code == 126
        assert box.lines == []
    finally:
        await ws.close()


def runtimes(node) -> list[str]:
    found = [node.runtime] if isinstance(node, CommandExplanation) else []
    for child in getattr(node, "children", ()) or ():
        found += runtimes(child)
    return found


@pytest.mark.asyncio
async def test_explain_names_the_sandbox_for_every_command_of_a_whole_line():
    box = Box(holds="")
    ws = workspace(box)
    lined = Box(holds="", captures=("@line",))
    by_line = workspace(lined)
    try:
        said = await ws.explain("cd /opt/app && make")
        assert runtimes(said.node) == ["box", "box"]
        said = await by_line.explain("cd /ram && make")
        assert runtimes(said.node) == ["box", "box"]
    finally:
        await ws.close()
        await by_line.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, asks",
    [
        ("cat /ram/a.txt", False),
        ("cd /ram && ls /ram", False),
        ("echo python3", True),
        ("env python3 -c x", True),
        ("./t", True),
    ],
)
async def test_only_a_line_that_may_run_an_interpreter_asks_the_box(
    line, asks
):
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell(line)
        assert box.probes == (1 if asks else 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, stderr",
    [
        ("python3 x.py", b"python3: x.py: not in EXEC mode\n"),
        ("python3 -c 1", b"python3: root mount '/' is not in EXEC mode\n"),
    ],
)
async def test_an_interpreter_the_box_took_keeps_the_mounts_exec_rule(
    line, stderr
):
    box = Box()
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.WRITE,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/ram/x.py", b"print(1)")
        await ws.shell("cd /ram")
        assert await run(ws, line) == (126, b"", stderr)
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_running_a_script_without_exec_is_refused():
    box = Box()
    ws = Workspace(
        {"/ram": RAMVFS(), "/run": (RAMVFS(), MountMode.EXEC)},
        mode=MountMode.WRITE,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/ram/x.py", b"print(1)")
        await ws.shell("cd /ram")
        assert await run(ws, "python3 x.py > /tmp/o") == (
            1,
            b"",
            b"python3: /ram/x.py is not in EXEC mode, and the line runs in "
            b"the sandbox for /tmp/o\n",
        )
        assert box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_interpreter_on_a_root_mount_stays_on_its_runtime():
    box = Box()
    ws = Workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/x.py", b"print(1)")
        assert await out(ws, "python3 /x.py") == b"monty\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_workspace_route_keeps_an_interpreter_the_box_took_in_mirage():
    class Keep(Policy):
        async def pre_execute(self, ctx):
            return Route("workspace")

    box = Box()
    ws = workspace(box, policies=[Keep()])
    try:
        await ws.shell("cd /ram")
        assert await out(ws, "python3 -c x") == b"monty\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "bash b.sh",
        "c='python3 x.py'; eval \"$c\"",
        "./x.py",
        "echo 'python3 x.py' | sh",
    ],
)
async def test_a_nested_interpreter_the_box_took_keeps_the_exec_rule(line):
    box = Box()
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.WRITE,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/ram/x.py", b"#!/usr/bin/env python3\nprint(1)\n")
        await ws.vfs.write("/ram/b.sh", b"python3 x.py\n")
        await ws.shell("cd /ram")
        await ws.shell("python3 -c 1")
        code, _, err = await run(ws, line)
        assert code == 126
        assert err.endswith(b"not in EXEC mode\n")
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_running_a_path_without_exec_is_refused():
    box = Box(holds="")
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.WRITE,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/ram/bin", BINARY)
        await ws.shell("cd /ram")
        assert await run(ws, "./bin > /tmp/o") == (
            1,
            b"",
            b"./bin: /ram/bin is not in EXEC mode, and the line runs in the "
            b"sandbox for /tmp/o\n",
        )
        assert box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_folder_holding_mounts_is_the_workspaces():
    box = Box(holds="")
    ws = Workspace(
        {"/data/a": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.shell("cd /data && make")
        assert box.whole == [] and box.lines == ["make"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_runtime_argument_asks_no_box():
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("python3 -c x", runtime="monty")
        assert box.probes == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_line_capture_beside_a_sandbox_keeps_every_line():
    box = Box(holds="")
    lined = Box(holds="", captures=("@line",))
    lined.name = "lined"
    ws = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[box, lined, Monty(), "workspace"],
    )
    try:
        await ws.shell("cd /opt/app && make")
        assert box.argvs == []
        assert lined.argvs == [("/bin/sh", "-c", "cd /opt/app && make")]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_unset_variable_is_no_refusal():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell("cd /opt && echo $NOPE; make")
        assert box.whole == ["cd /opt && echo $NOPE; make"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_route_policy_still_keeps_a_root_interpreter_off_the_box():
    box = Box()
    ws = workspace(box, route_policy=lambda ctx: None)
    try:
        await ws.shell("echo 'print(1)' > /hello.py")
        assert await out(ws, "python3 /hello.py") == b"monty\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cwd, line, ran",
    [
        ("/x", "python3 -u /w/x.py", False),
        ("/x", "python3 -X dev /w/x.py", False),
        ("/x", "python3 -- /w/x.py", False),
        ("/x", "python3 /w/x.py -c", False),
        ("/w", "python3 -u /x/x.py", True),
    ],
)
async def test_the_exec_rule_reads_the_interpreters_own_options(
    cwd, line, ran
):
    box = Box()
    ws = Workspace(
        {"/x": (RAMVFS(), MountMode.EXEC), "/w": (RAMVFS(), MountMode.WRITE)},
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/x/x.py", b"print(1)")
        await ws.vfs.write("/w/x.py", b"print(1)")
        await ws.shell("cd /x && python3 -c 1")
        box.lines.clear()
        await ws.shell(f"cd {cwd}")
        code, _, err = await run(ws, line)
        if ran:
            assert (code, box.lines) == (0, [line])
        else:
            assert (code, err) == (
                126,
                b"python3: /w/x.py: not in EXEC mode\n",
            )
            assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_keeps_the_exec_rule_for_an_interpreter_bound_elsewhere():
    box = Box()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.WRITE,
        runtimes=[Monty(), box, "workspace"],
    )
    try:
        await ws.vfs.write("/data/x.py", b"print(1)")
        assert await run(ws, "python3 /data/x.py > /tmp/log; make") == (
            1,
            b"",
            b"python3: /data/x.py is not in EXEC mode, and the line runs in "
            b"the sandbox for /tmp/log\n",
        )
        assert box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_naming_a_file_mirage_holds_on_its_root_is_refused():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell("echo old > /notes.txt")
        await ws.shell("cd /ram")
        assert await run(ws, "nproc > /tmp/count; echo new > /notes.txt") == (
            1,
            b"",
            b"nproc: /notes.txt is in Mirage, but /tmp/count is on the "
            b"sandbox; run them on separate lines\n",
        )
        assert box.whole == []
        assert await out(ws, "cat /notes.txt") == b"old\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, split",
    [("nproc > /out", ["nproc"]), ("cat /out | gcc -", ["gcc -"])],
)
async def test_a_link_mirage_holds_on_its_root_is_followed(line, split):
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell("echo hi > /ram/result; ln -s /ram/result /out")
        await ws.shell(line)
        assert box.whole == []
        assert box.lines == split
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line", ["/hello.py", "env python3 /hello.py", "sh -c 'python3 /hello.py'"]
)
async def test_an_interpreter_reached_on_mirages_own_root_stays_on_its_runtime(
    line,
):
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("cd /ram && python3 -c 1")
        await ws.vfs.write("/hello.py", b"#!/usr/bin/env python3\nprint(1)\n")
        await ws.shell("chmod +x /hello.py")
        box.lines.clear()
        await ws.shell("cd /ram")
        assert await out(ws, line) == b"monty\n"
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_the_root_fallback_is_chosen_per_invocation():
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("cd /ram && python3 -c 1")
        await ws.shell("cd /")
        line = "python3 -c 1; cd /ram; python3 -c 2"
        assert await out(ws, line) == b"monty\nbox\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explain_names_the_runtime_an_interpreter_falls_back_to():
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("cd /ram && python3 -c 1")
        await ws.shell("cd /")
        said = await ws.explain("python3 -c 1; cd /ram; python3 -c 2")
        assert runtimes(said.node) == ["monty", "", "box"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_no_sandbox_that_learned_an_interpreter_keeps_it_in_mirage():
    class Keep(Policy):
        async def pre_execute(self, ctx):
            return Route("workspace")

    first, second = Box(), Box()
    second.name = "box2"
    kept = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[first, second, Monty(), "workspace"],
        policies=[Keep()],
    )
    third, fourth = Box(), Box()
    fourth.name = "box2"
    rooted = Workspace(
        {"/ram": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[third, fourth, Monty(), "workspace"],
    )
    try:
        await kept.shell("cd /ram")
        assert await out(kept, "python3 -c x") == b"monty\n"
        assert first.lines == [] and second.lines == []
        await rooted.shell("cd /ram && python3 -c 1")
        await rooted.shell("cd /")
        assert await out(rooted, "python3 -c x") == b"monty\n"
    finally:
        await kept.close()
        await rooted.close()


@pytest.mark.asyncio
async def test_a_binary_on_mirages_own_root_answers_126():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.vfs.write("/t", BINARY)
        code, _, _ = await run(ws, "/t a")
        assert code == 126
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "setup, options",
    [
        ("set -C", ("-o", "noclobber")),
        (
            "set -euo pipefail",
            ("-o", "errexit", "-o", "nounset", "-o", "pipefail"),
        ),
        ("set +B", ("+o", "braceexpand")),
        ("shopt -s nullglob", ("-O", "nullglob")),
        ("set -C; set +C", ()),
    ],
)
async def test_a_whole_line_carries_the_sessions_shell_options(setup, options):
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.shell(setup)
        await ws.shell("cd /opt/app && make")
        assert box.argvs[-1][3:] == (
            "sh",
            "cd /opt/app && make",
            "box",
            *options,
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "link, target, line",
    [
        ("/ram/link.py", "/hello.py", "python3 /ram/link.py"),
        ("/entry.py", "/ram/app.py", "python3 /entry.py"),
    ],
)
async def test_a_script_linked_to_or_from_mirages_own_root_stays_on_its_runtime(
    link, target, line
):
    box = Box()
    ws = workspace(box)
    try:
        await ws.shell("cd /ram && python3 -c 1")
        await ws.vfs.write(target, b"print(1)\n")
        await ws.shell(f"ln -s {target} {link}")
        box.lines.clear()
        assert await out(ws, line) == b"monty\n"
        assert box.lines == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_whole_line_judges_the_interpreters_script_not_a_redirect():
    box = Box()
    ws = Workspace(
        {"/ram": RAMVFS(), "/run": (RAMVFS(), MountMode.EXEC)},
        mode=MountMode.WRITE,
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.shell("cd /ram")
        line = "python3 - > /tmp/out; make"
        assert (await run(ws, line))[0] == 0
        assert box.whole == [line]
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, code",
    [("python3 /x/link.py", 126), ("python3 /x/link.py > /tmp/o; make", 1)],
)
async def test_an_interpreter_the_box_took_judges_the_scripts_link_target(
    line, code
):
    box = Box()
    ws = Workspace(
        {"/x": (RAMVFS(), MountMode.EXEC), "/w": (RAMVFS(), MountMode.WRITE)},
        runtimes=[box, Monty(), "workspace"],
    )
    try:
        await ws.vfs.write("/w/app.py", b"print(1)")
        await ws.shell("cd /x && python3 -c 1")
        await ws.shell("ln -s /w/app.py /x/link.py")
        box.lines.clear()
        got, _, err = await run(ws, line)
        assert (got, b"/w/app.py" in err) == (code, True)
        assert box.lines == [] and box.whole == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_binary_linked_from_mirages_own_root_answers_126():
    box = Box(holds="")
    ws = workspace(box)
    try:
        await ws.vfs.write("/ram/t", BINARY)
        await ws.shell("ln -s /ram/t /entry")
        await ws.shell("cd /ram")
        code, _, _ = await run(ws, "/entry a")
        assert code == 126
        assert box.lines == []
    finally:
        await ws.close()
