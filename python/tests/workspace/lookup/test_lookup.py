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

from mirage.commands.cli.types import CLISpec
from mirage.io import IOResult
from mirage.policy.types import AdmissionRules
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.types import ProcessExecution, RunResult
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.lookup import (
    SHELL_CONSUMERS,
    Consumer,
    command_visible,
    execs,
    lookup,
    lookup_all,
    program,
    program_note,
    programs,
    verb_visible,
)
from mirage.workspace.session import SessionState


class _Sandbox(Runtime, ProcessExecutorMixin):
    name = "sandbox"
    captures = ("gcc", EXTERNAL_COMMANDS)

    async def run_process(self, request: ProcessExecution) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


def _fixture() -> tuple[SessionState, Workspace]:
    ws = Workspace(mounts={"/ram": (RAMVFS(), MountMode.WRITE)})
    return SessionState(session_id="t"), ws


async def _noop(config, paths, *texts, **flags):
    return None, IOResult()


def _cli_tree() -> CLISpec:
    return CLISpec(name="prog", subcommands=(CLISpec(name="run", fn=_noop),))


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


def test_unregistered_cli_routes_unknown():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    ws.unregister_cli("prog")
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


def test_verb_visible_answers_below_the_head_word_command_visible_answers():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("prog run",))
    # Dispatch routes by the head word, which stays visible: one line of
    # the tree runs.
    assert command_visible("prog", session)
    assert lookup("prog", session, ws._registry) is Consumer.CLI
    assert verb_visible("prog", (), session)
    assert verb_visible("prog", ("run",), session)
    # A verb the list does not reach is not this session's to discover,
    # though the head word it hangs off is.
    assert not verb_visible("prog", ("stop",), session)
    # No list: every verb of every tree.
    session.commands = None
    assert verb_visible("prog", ("stop",), session)


def test_allow_lists_filter_every_layer_and_spare_only_functions():
    session, ws = _fixture()
    ws.register_cli("prog", _cli_tree())
    session.commands = AdmissionRules(allow=("cat", "prog", "ln"))
    reg = ws._registry
    # Listed: visible in its layer, whichever layer that is.
    assert lookup("cat", session, reg) is Consumer.MOUNT
    assert lookup("prog", session, reg) is Consumer.CLI
    assert lookup("ln", session, reg) is Consumer.NAMESPACE
    # Unlisted: not a command for the session (sleep is a tool-tier
    # builtin, rm a mount command).
    assert lookup("sleep", session, reg) is Consumer.UNKNOWN
    assert lookup("rm", session, reg) is Consumer.UNKNOWN
    assert lookup_all("rm", session, reg) == []
    assert not command_visible("rm", session)
    # Builtins are subjects like everything else: an allow list stating
    # cat leaves no cd and no echo.
    assert lookup("cd", session, reg) is Consumer.UNKNOWN
    assert lookup("echo", session, reg) is Consumer.UNKNOWN
    assert not command_visible("cd", session)
    session.commands = AdmissionRules(allow=("cat", "prog", "ln", "cd"))
    assert lookup("cd", session, reg) is Consumer.SESSION
    assert command_visible("cd", session)
    session.commands = AdmissionRules(allow=("cat", "prog", "ln"))
    # A function is the session's own state, visible where it is what
    # runs; named after a hidden builtin it is as unreachable as the
    # builtin, since builtins shadow functions here.
    session.functions["deploy"] = "deploy() { :; }"
    assert lookup("deploy", session, reg) is Consumer.FUNCTION
    assert command_visible("deploy", session)
    session.functions["sleep"] = "sleep() { :; }"
    assert lookup("sleep", session, reg) is Consumer.UNKNOWN
    assert not command_visible("sleep", session)
    # A function shadowing a hidden CLI or mount command runs, and the
    # hidden layer stays out of `type -a`.
    session.functions["rm"] = "rm() { :; }"
    assert lookup_all("rm", session, reg) == [Consumer.FUNCTION]
    # No allow list at all: nothing filtered (the function still
    # shadows).
    session.commands = None
    assert lookup_all("rm", session, reg) == [
        Consumer.FUNCTION,
        Consumer.MOUNT,
    ]
    assert lookup("sleep", session, reg) is Consumer.SESSION


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


def test_programs_follows_the_allow_list():
    _, ws = _fixture()
    narrow = SessionState(
        session_id="n", commands=AdmissionRules(allow=("cat",))
    )
    assert programs(narrow, ws._registry) == ["cat"]


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
    assert lookup_all("history", session, ws._registry) == [
        Consumer.SESSION,
        Consumer.MOUNT,
    ]
    assert program("history", session, ws._registry) is None
    assert "history" not in programs(session, ws._registry)


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
