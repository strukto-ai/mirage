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

from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import command
from mirage.commands.spec.types import CommandSpec
from mirage.io import IOResult
from mirage.policy.match.allow import head_allowed
from mirage.policy.types import AdmissionRules, CommandExplanation
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import Program, RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.lookup import (
    SHELL_CONSUMERS,
    Consumer,
    execs,
    lookup,
    lookup_all,
    program,
    program_note,
    programs,
)
from mirage.workspace.session import SessionState


class _Sandbox(Runtime, ProcessExecutorMixin):
    name = "sandbox"
    captures = ("gcc", EXTERNAL_COMMANDS)

    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class _HostPython(PythonRuntime, ProcessExecutorMixin):
    name = "host-python"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)

    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class _HostTools(_HostPython):
    name = "host-tools"
    captures = ("python3", "gcc")


def _fixture() -> tuple[SessionState, Workspace]:
    ws = Workspace(
        mounts={"/ram": (RAMVFS(), MountMode.WRITE)},
        runtimes=["monty", "workspace"],
    )
    return SessionState(session_id="t"), ws


async def _noop(accessor, paths, texts, ctx):
    return None, IOResult()


@command("history", vfs="ram", spec=CommandSpec())
async def _mount_history(accessor, paths, texts, ctx):
    return None, IOResult()


def _cli_tree() -> CLI:
    return CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="run"),)),
        handlers={"run": CLIHandler(fn=_noop)},
    )


def test_builtins_route_session():
    session, ws = _fixture()
    for name in ("cd", "echo", "export", "history", "test", "xargs"):
        assert lookup(name, session, ws._registry) is Consumer.SESSION


def test_unsupported_builtins_route_session():
    session, ws = _fixture()
    assert lookup("exec", session, ws._registry) is Consumer.SESSION


def test_namespace_commands():
    session, ws = _fixture()
    assert lookup("ln", session, ws._registry) is Consumer.NAMESPACE
    assert lookup("readlink", session, ws._registry) is Consumer.NAMESPACE


def test_function_routes_function():
    session, ws = _fixture()
    session.functions["greet"] = "greet() { :; }"
    assert lookup("greet", session, ws._registry) is Consumer.FUNCTION


def test_builtin_shadows_function():
    session, ws = _fixture()
    session.functions["echo"] = "echo() { :; }"
    assert lookup("echo", session, ws._registry) is Consumer.SESSION


def test_function_shadows_mount_command():
    session, ws = _fixture()
    session.functions["cat"] = "cat() { :; }"
    assert lookup("cat", session, ws._registry) is Consumer.FUNCTION


def test_mount_command_routes_mount():
    session, ws = _fixture()
    assert lookup("cat", session, ws._registry) is Consumer.MOUNT
    assert lookup("grep", session, ws._registry) is Consumer.MOUNT


def test_unregistered_name_routes_unknown():
    session, ws = _fixture()
    assert lookup("nosuchcmd", session, ws._registry) is Consumer.UNKNOWN


def test_installed_cli_routes_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert lookup("prog", session, ws._registry) is Consumer.CLI


def test_function_shadows_installed_cli():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["prog"] = "prog() { :; }"
    assert lookup("prog", session, ws._registry) is Consumer.FUNCTION


@pytest.mark.asyncio
async def test_unregistered_cli_routes_unknown():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    await ws.unregister_cli("prog")
    assert lookup("prog", session, ws._registry) is Consumer.UNKNOWN


def test_shell_consumers_resolve_globs():
    assert Consumer.SESSION in SHELL_CONSUMERS
    assert Consumer.NAMESPACE in SHELL_CONSUMERS
    assert Consumer.FUNCTION in SHELL_CONSUMERS
    # A CLI is a program: bash hands programs glob matches, never
    # patterns.
    assert Consumer.CLI in SHELL_CONSUMERS
    assert Consumer.MOUNT not in SHELL_CONSUMERS
    assert Consumer.UNKNOWN not in SHELL_CONSUMERS


def test_route_all_reports_every_layer_winner_first():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    assert lookup_all("prog", session, ws._registry) == [Consumer.CLI]
    session.functions["prog"] = "prog() { :; }"
    assert lookup_all("prog", session, ws._registry) == [
        Consumer.FUNCTION,
        Consumer.CLI,
    ]


def test_route_all_is_empty_where_route_says_unknown():
    session, ws = _fixture()
    assert lookup_all("bogus", session, ws._registry) == []
    assert lookup("bogus", session, ws._registry) is Consumer.UNKNOWN


def test_route_agrees_with_the_first_layer_route_all_reports():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.functions["greet"] = "greet() { :; }"
    for name in ("cd", "ln", "greet", "prog", "cat", "bogus"):
        layers = lookup_all(name, session, ws._registry)
        winner = layers[0] if layers else Consumer.UNKNOWN
        assert lookup(name, session, ws._registry) is winner


def test_an_allow_list_does_not_narrow_lookup():
    # The allow list is a policy: a word it leaves out is still found in
    # its layer, and the gate refuses it when it runs.
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("cat",))
    reg = ws._registry
    assert lookup("cat", session, reg) is Consumer.MOUNT
    assert lookup("prog", session, reg) is Consumer.CLI
    assert lookup("ln", session, reg) is Consumer.NAMESPACE
    assert lookup("rm", session, reg) is Consumer.MOUNT
    assert lookup("cd", session, reg) is Consumer.SESSION
    # A function shadows a command as it does with no list.
    session.functions["rm"] = "rm() { :; }"
    assert lookup_all("rm", session, reg) == [
        Consumer.FUNCTION,
        Consumer.MOUNT,
    ]


def test_program_is_what_a_real_system_ships_as_a_file():
    session, ws = _fixture()
    registry = ws._registry
    assert program("cat", session, registry) is Consumer.MOUNT
    assert program("readlink", session, registry) is Consumer.NAMESPACE
    # A builtin a real system also finds on disk keeps its file.
    assert program("echo", session, registry) is Consumer.SESSION
    assert program("xargs", session, registry) is Consumer.SESSION
    # The shell's own words, reserved words and unknowns have none.
    for name in ("cd", "export", "if", "nope-xyz", "/bin/ls"):
        assert program(name, session, registry) is None


def test_execs_finds_programs_functions_and_paths():
    session, ws = _fixture()
    registry = ws._registry
    session.functions["myfn"] = "myfn() { :; }"
    session.functions["cd"] = "cd() { :; }"
    for name in ("cat", "echo", "xargs", "myfn", "./run.sh", "/data/x"):
        assert execs(name, session, registry)
    for name in ("cd", "export", "if", "nope-xyz"):
        assert not execs(name, session, registry)


def test_program_keeps_the_file_under_a_shadowing_function():
    session, ws = _fixture()
    session.functions["cat"] = "cat() { :; }"
    assert lookup("cat", session, ws._registry) is Consumer.FUNCTION
    assert program("cat", session, ws._registry) is Consumer.MOUNT
    session.functions["myfn"] = "myfn() { :; }"
    assert program("myfn", session, ws._registry) is None


def test_programs_lists_every_program_the_session_can_run():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    names = programs(session, ws._registry)
    assert names == sorted(names)
    assert {"cat", "echo", "prog", "readlink", "xargs"} <= set(names)
    assert not {"cd", "export", "[["} & set(names)


def test_programs_lists_every_program_whatever_the_allow_list():
    session, ws = _fixture()
    narrow = SessionState(
        session_id="n", commands=AdmissionRules(allow=("cat",))
    )
    assert programs(narrow, ws._registry) == programs(session, ws._registry)


# Debian's egrep is `exec grep -E "$@"`, so it is a program wherever grep
# is one, and an allow list naming only grep refuses it when it runs.
def test_a_wrapper_is_a_program_where_what_it_runs_is():
    session, ws = _fixture()
    registry = ws._registry
    for name in ("egrep", "fgrep", "zegrep", "zfgrep"):
        assert lookup(name, session, registry) is Consumer.MOUNT
        assert name in programs(session, registry)
    assert program_note("egrep", session, registry) == (
        "egrep is built into mirage. Help: egrep --help"
    )
    narrow = SessionState(
        session_id="n", commands=AdmissionRules(allow=("grep",))
    )
    assert lookup("egrep", narrow, registry) is Consumer.MOUNT
    assert not head_allowed("egrep", narrow.commands)


# An interpreter is a program only where a language runtime runs it; a
# workspace without one answers `python3: command not found`, as a system
# that never installed it does, so neither `which` nor `ls /usr/bin`
# finds it.
def test_program_has_no_file_for_an_interpreter_no_language_runtime_runs():
    session = SessionState(session_id="t")
    ws = Workspace({"/": RAMVFS()}, runtimes=["workspace"])
    for name in ("python3", "python", "node"):
        assert program(name, session, ws._registry) is None
        assert name not in programs(session, ws._registry)


def test_program_keeps_the_file_for_an_interpreter_a_runtime_runs():
    session, ws = _fixture()
    assert program("python3", session, ws._registry) is Consumer.SESSION
    assert "python3" in programs(session, ws._registry)


def test_program_has_no_file_for_a_shell_word_a_mount_also_registers():
    session, ws = _fixture()
    ws.mount("/ram").register_commands([_mount_history])
    assert lookup_all("history", session, ws._registry) == [
        Consumer.SESSION,
        Consumer.MOUNT,
    ]
    assert program("history", session, ws._registry) is None
    assert "history" not in programs(session, ws._registry)


def test_a_language_runtime_that_runs_processes_keeps_its_own_names():
    session = SessionState(session_id="t")
    ws = Workspace(
        {"/": RAMVFS()}, runtimes=[_HostPython(captures=["python3", "gcc"])]
    )
    assert lookup("python3", session, ws._registry) is Consumer.SESSION
    assert lookup("gcc", session, ws._registry) is Consumer.EXTERNAL


def test_a_class_capture_beside_the_language_names_runs_natively():
    session = SessionState(session_id="t")
    ws = Workspace({"/": RAMVFS()}, runtimes=[_HostTools()])
    assert lookup("python3", session, ws._registry) is Consumer.SESSION
    assert lookup("gcc", session, ws._registry) is Consumer.EXTERNAL


def test_program_is_no_file_for_a_name_only_the_fallback_takes():
    session = SessionState(session_id="t")
    ws = Workspace({"/": RAMVFS()}, runtimes=[_Sandbox()])
    assert lookup("native-tool", session, ws._registry) is Consumer.EXTERNAL
    assert program("native-tool", session, ws._registry) is None
    assert program("gcc", session, ws._registry) is Consumer.EXTERNAL
    assert "gcc" in programs(session, ws._registry)


def test_program_note_says_what_runs_the_name():
    session, ws = _fixture()
    registry = ws._registry
    ws.register_cli("prog", _cli_tree())
    assert program_note("cat", session, registry) == (
        "cat is built into mirage. Help: cat --help"
    )
    assert program_note("prog", session, registry) == (
        "prog is a CLI registered with this workspace. Help: prog --help"
    )
    assert program_note("python3", session, registry) == (
        "python3 runs on the workspace's monty runtime."
    )
    # A builtin's --help varies, so its line names none.
    for name in ("echo", "ln", "xargs"):
        assert (
            program_note(name, session, registry)
            == f"{name} is built into mirage."
        )
    assert program_note("cd", session, registry) is None


def test_program_note_names_the_runtime_a_capture_runs_on():
    session = SessionState(session_id="t")
    ws = Workspace({"/": RAMVFS()}, runtimes=[_Sandbox()])
    assert program_note("gcc", session, ws._registry) == (
        "gcc runs on the workspace's sandbox runtime."
    )
    assert program_note("native-tool", session, ws._registry) is None


class _Box(Runtime, LineExecutorMixin):
    """A line runtime that answers its own name."""

    reach = "remote"

    def __init__(self, name: str, *captures: str) -> None:
        super().__init__(captures=captures)
        self.name = name

    async def run_line(self, engine, paths, texts, ctx):
        return RunResult(
            stdout=f"{self.name}\n".encode(), stderr=None, exit_code=0
        )


class _Monty(PythonRuntime):
    name = "monty"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        return RunResult(stdout=b"monty\n", stderr=None, exit_code=0)


def _commands(node) -> list[str]:
    found = [node.runtime] if isinstance(node, CommandExplanation) else []
    for child in getattr(node, "children", ()) or ():
        found += _commands(child)
    return found


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "external, line, runs",
    [
        (True, "nice gcc x.c", "docker"),
        (True, "nice -n -5 gcc x.c", "docker"),
        (True, "nice -- gcc x.c", "docker"),
        (True, "nohup gcc x.c", "docker"),
        (True, "nice nohup gcc x.c", "docker"),
        (True, "stdbuf -o L gcc x.c", "docker"),
        (True, "ionice -c2 gcc x.c", "docker"),
        (True, "setsid -w gcc x.c", "docker"),
        (False, "nice gcc x.c", "docker"),
        (True, "make -j2", "e2b"),
        (True, "nice make", "e2b"),
        (True, "nice", "e2b"),
        (True, "sudo gcc x.c", "e2b"),
    ],
)
async def test_a_wrapper_runs_where_the_program_it_runs_is_captured(
    external, line, runs
):
    entries = [_Box("docker", "gcc"), _Monty(), "workspace"]
    if external:
        entries.insert(0, _Box("e2b", "@external"))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=entries)
    try:
        io = await ws.shell(line)
        assert (io.exit_code, await io.stdout_str()) == (0, f"{runs}\n")
        said = await ws.explain(line)
        assert _commands(said.node)[0] == runs
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_around_a_mirage_command_is_explained_as_mirage_runs_it():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[_Box("e2b", "@external"), "workspace"],
    )
    try:
        await ws.shell("echo hit > /data/f")
        line = "nice grep hit /data/f"
        io = await ws.shell(line)
        assert (io.exit_code, await io.stdout_str()) == (0, "hit\n")
        said = await ws.explain(line)
        assert _commands(said.node)[0] == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_script_path_is_explained_as_mirage_runs_it():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[_Box("e2b", "@external"), "workspace"],
    )
    try:
        await ws.shell(
            "echo 'echo here' > /data/run.sh; chmod +x /data/run.sh"
        )
        io = await ws.shell("/data/run.sh")
        assert (io.exit_code, await io.stdout_str()) == (0, "here\n")
        said = await ws.explain("/data/run.sh")
        assert _commands(said.node)[0] == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_a_runtime_captures_runs_there():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[_Box("niced", "nice"), _Box("docker", "gcc"), "workspace"],
    )
    try:
        io = await ws.shell("nice gcc x.c")
        assert await io.stdout_str() == "niced\n"
    finally:
        await ws.close()


class _Echo(_Box):
    """A line runtime that answers the line it was handed."""

    async def run_line(self, engine, paths, texts, ctx):
        return RunResult(
            stdout=f"{ctx.flags['c']}\n".encode(), stderr=None, exit_code=0
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("external", [False, True])
async def test_a_wrapped_programs_globs_expand_as_the_programs_do(external):
    entries = [_Echo("docker", "gcc"), "workspace"]
    if external:
        entries.insert(0, _Box("e2b", "@external"))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=entries)
    try:
        await ws.vfs.write("/data/a.c", b"")
        await ws.vfs.write("/data/b.c", b"")
        io = await ws.shell("cd /data && nice gcc *.c")
        assert await io.stdout_str() == "nice gcc a.c b.c\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("external", [False, True])
async def test_a_function_named_like_a_wrapper_is_explained_as_it_runs(
    external,
):
    entries = [_Box("docker", "gcc"), "workspace"]
    if external:
        entries.insert(0, _Box("e2b", "@external"))
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=entries)
    try:
        await ws.shell("nice() { echo local; }")
        io = await ws.shell("nice gcc x.c")
        assert await io.stdout_str() == "local\n"
        said = await ws.explain("nice gcc x.c")
        assert _commands(said.node)[0] == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_command_past_a_wrapper_function_is_explained_as_it_runs():
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[_Box("docker", "gcc"), "workspace"],
    )
    try:
        await ws.shell("nice() { echo local; }")
        io = await ws.shell("command nice gcc x.c")
        assert await io.stdout_str() == "docker\n"
        said = await ws.explain("command nice gcc x.c")
        assert _commands(said.node) == ["", "docker", "docker"]
        assert "nice" in ws.get_session(ws.default_session_id).functions
    finally:
        await ws.close()


def _mirage_workspace(*entries) -> Workspace:
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[*entries, "workspace"],
        profiles={"tight": {"commands": {"allow": ["cd", "grep"]}}},
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "external, line, out",
    [
        (True, "nice grep python f", "python here\n"),
        (False, "nice grep python f", "python here\n"),
        (True, "nohup cat f", "python here\n"),
        (True, "nice -n 5 grep python f", "python here\n"),
        (True, "nice nohup grep python f", "python here\n"),
        (False, "nice grep -h python *.txt", "python a\npython b\n"),
        (True, "nice python3 -c 1", "monty\n"),
        (True, "stdbuf -oL grep python f", "python here\n"),
    ],
)
async def test_a_wrapper_around_mirages_program_runs_it_in_mirage(
    external, line, out
):
    entries = [_Box("docker", "gcc"), _Monty()]
    if external:
        entries.insert(0, _Box("e2b", "@external"))
    ws = _mirage_workspace(*entries)
    try:
        await ws.vfs.write("/data/f", b"python here\n")
        await ws.vfs.write("/data/a.txt", b"python a\n")
        await ws.vfs.write("/data/b.txt", b"python b\n")
        await ws.shell("cd /data")
        io = await ws.shell(line)
        assert (io.exit_code, await io.stdout_str()) == (0, out)
        said = await ws.explain(line)
        assert _commands(said.node)[0] == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out",
    [
        ("foo() { echo hi; }; nice foo", "hi\n"),
        ("nice python3 -c 1", "e2b\n"),
        ("nice --help grep x", "e2b\n"),
        ("ionice -p 1 grep x", "e2b\n"),
    ],
)
async def test_a_wrapper_runs_a_function_and_keeps_its_route_otherwise(
    line, out
):
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[_Box("e2b", "@external"), "workspace"],
    )
    try:
        io = await ws.shell(line)
        assert (io.exit_code, await io.stdout_str()) == (0, out)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapper_the_allow_list_leaves_out_is_still_refused():
    ws = _mirage_workspace(_Box("e2b", "@external"))
    try:
        await ws.vfs.write("/data/f", b"python here\n")
        ws.create_session("s", profile="tight")
        assert (
            await ws.shell("cd /data && grep python f", session_id="s")
        ).exit_code == 0
        io = await ws.shell("cd /data && nice grep python f", session_id="s")
        assert io.exit_code == 126
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, code, said",
    [
        ("nice cd /data", 127, "nice: 'cd': No such file or directory\n"),
        (
            "nohup cd /data",
            127,
            "nohup: failed to run command 'cd': No such file or directory\n",
        ),
        (
            "stdbuf -oL cd /data",
            127,
            "stdbuf: failed to run command 'cd': No such file or directory\n",
        ),
        (
            "ionice -c3 cd /data",
            127,
            "ionice: failed to execute cd: No such file or directory\n",
        ),
        (
            "setsid cd /data",
            127,
            "setsid: failed to execute cd: No such file or directory\n",
        ),
        (
            "nice --bogus rm f",
            125,
            "nice: unrecognized option '--bogus'\n"
            "Try 'nice --help' for more information.\n",
        ),
        (
            "nice -x rm f",
            125,
            "nice: invalid option -- 'x'\n"
            "Try 'nice --help' for more information.\n",
        ),
        ("nice -n abc rm f", 125, "nice: invalid adjustment 'abc'\n"),
        (
            "nohup -x rm f",
            125,
            "nohup: invalid option -- 'x'\n"
            "Try 'nohup --help' for more information.\n",
        ),
        ("stdbuf -o abc rm f", 125, "stdbuf: invalid mode 'abc'\n"),
        (
            "stdbuf -o 1Q rm f",
            125,
            "stdbuf: invalid mode '1Q': Value too large for defined data type\n",
        ),
        (
            "stdbuf rm f",
            125,
            "stdbuf: you must specify a buffering mode option\n"
            "Try 'stdbuf --help' for more information.\n",
        ),
        (
            "stdbuf -i L rm f",
            125,
            "stdbuf: line buffering stdin is meaningless\n"
            "Try 'stdbuf --help' for more information.\n",
        ),
        ("ionice -c abc rm f", 1, "ionice: unknown scheduling class: 'abc'\n"),
        (
            "ionice -n 1x rm f",
            1,
            "ionice: invalid class data argument: '1x'\n",
        ),
        (
            "setsid -x rm f",
            1,
            "setsid: invalid option -- 'x'\n"
            "Try 'setsid --help' for more information.\n",
        ),
    ],
)
async def test_a_wrapper_mirage_runs_for_refuses_as_gnu_does(line, code, said):
    ws = _mirage_workspace(_Box("e2b", "@external"))
    try:
        await ws.vfs.write("/data/f", b"kept\n")
        io = await ws.shell(f"cd / && {line}")
        assert (io.exit_code, await io.stderr_str()) == (code, said)
        assert await (await ws.shell("pwd; cat /data/f")).stdout_str() == (
            "/\nkept\n"
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "nice -n +3 cat /data/f",
        "nice -10 cat /data/f",
        "nice --adj 3 cat /data/f",
        "stdbuf -o 1KB -e0 cat /data/f",
        "ionice -c idle -n 0 cat /data/f",
        "setsid -fw cat /data/f",
    ],
)
async def test_a_wrapper_with_good_options_runs_its_program(line):
    ws = _mirage_workspace(_Box("e2b", "@external"))
    try:
        await ws.vfs.write("/data/f", b"kept\n")
        io = await ws.shell(line)
        assert (io.exit_code, await io.stdout_str()) == (0, "kept\n")
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_wrapped_program_streams_its_output():
    ws = _mirage_workspace()
    try:
        await ws.vfs.write("/data/log", b"one\n")
        io = await asyncio.wait_for(
            ws.shell("nice tail -f /data/log | head -n 1"), 10
        )
        assert await io.stdout_str() == "one\n"
    finally:
        await ws.close()
