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
from dataclasses import asdict
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.config import Context, command
from mirage.commands.errors import PartialOutputError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import Argument, CommandSpec, UsageStyle
from mirage.errors.types import CommandTimeoutError
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import Action, Deny, Policy
from mirage.policy.types import SessionContext
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.routing import RouteDecision
from mirage.runtime.types import Program, RunResult, ScriptSource
from mirage.runtime.workspace import WorkspaceRuntime
from mirage.shell.variable import VarAttr
from mirage.types import Limit, MountMode, PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.cli import (
    CLIContext,
    handle_cli,
    reaches_service,
)
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.mount.mount import MountEntry
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import seed_var, set_attr


class TokenConfig(BaseModel):
    token: str


CALLS: list[tuple] = []


def token_install(name: str, cli: CLI, token: str = "tok") -> CLIInstall:
    config = TokenConfig(token=token)
    return CLIInstall(
        name=name, cli=cli, config=config, accessor=NOOPAccessor(config)
    )


async def send(accessor: NOOPAccessor, paths, texts, ctx: Context):
    CALLS.append((accessor, paths, texts, ctx))
    return f"sent[{accessor.config.token}]\n".encode(), IOResult()


def send_sync(accessor: NOOPAccessor, paths, texts, ctx: Context):
    return f"sync[{accessor.config.token}]\n".encode(), IOResult()


def raise_sync(config: TokenConfig, paths, texts, ctx: Context):
    raise RuntimeError("sync boom")


def raise_after_output(config: TokenConfig, paths, texts, ctx: Context):
    raise PartialOutputError("late boom", b"first\n")


def make_sync_install(fn) -> CLIInstall:
    spec = CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="go"),)),
        handlers={"go": CLIHandler(fn=fn)},
        config_model=TokenConfig,
    )
    return token_install("prog", spec)


def make_install(name: str = "prog") -> CLIInstall:
    spec = CLI(
        spec=CommandSpec(
            name="prog",
            subcommands=(
                CommandSpec(
                    name="message",
                    subcommands=(
                        CommandSpec(
                            name="send",
                            arguments=(
                                Argument("-t", "--to", required=True),
                                Argument("--style", choices=("top", "bottom")),
                                Argument("texts", nargs="*", metavar=""),
                            ),
                        ),
                    ),
                ),
            ),
            arguments=(Argument("-v", "--verbose", action="count"),),
        ),
        handlers={"message send": CLIHandler(fn=send)},
        config_model=TokenConfig,
    )
    return token_install(name, spec)


@pytest.mark.asyncio
async def test_leaf_runs_with_config_group_flags_and_texts():
    CALLS.clear()
    install = make_install()
    parts = ["prog", "-vv", "message", "send", "-t", "#eng", "hello", "world"]
    session = SessionState("t")
    seed_var(session, "EDITOR", "vi")
    # Exported: `ctx.env` is the process view a CLI receives, which
    # carries exported names only, the way a child process's environ
    # does. A plain shell variable is deliberately not in it.
    set_attr(session, "EDITOR", VarAttr.EXPORT)
    stdout, io, node = await handle_cli(install, parts, session)
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sent[tok]\n"
    accessor, _, texts, ctx = CALLS.pop()
    assert accessor.config.token == "tok"
    assert texts == ["hello", "world"]
    assert ctx.flags["to"] == "#eng"
    assert ctx.flags["verbose"] == 2
    assert ctx.argv == (
        "-vv",
        "message",
        "send",
        "-t",
        "#eng",
        "hello",
        "world",
    )
    # `$PWD` is exported, so a CLI subprocess inherits it as bash's would.
    assert ctx.env == {"EDITOR": "vi", "PWD": "/"}
    assert node.command == "prog -vv message send -t #eng hello world"

    paths_install = token_install(
        "paths",
        CLI(
            CommandSpec(
                name="paths",
                arguments=(
                    Argument("prefix", nargs="?"),
                    Argument("FILE", type="path"),
                    Argument(
                        "--output",
                        type="path",
                        nargs=1,
                        env="OUTPUT",
                        default="./default",
                    ),
                ),
            ),
            handlers={"": CLIHandler(send)},
        ),
    )
    for words in (["report.txt"], ["prefix", "report.txt"]):
        path_session = SessionState("paths", cwd="/work")
        expected_output = "default"
        if len(words) > 1:
            seed_var(path_session, "OUTPUT", "./environment")
            set_attr(path_session, "OUTPUT", VarAttr.EXPORT)
            expected_output = "environment"
        stdout, result, _ = await handle_cli(
            paths_install,
            ["paths", *words],
            path_session,
        )
        await materialize(stdout)
        assert result.exit_code == 0
        _, paths, texts, received = CALLS.pop()
        assert texts == words[:-1]
        assert [path.virtual for path in paths] == ["/work/report.txt"]
        assert isinstance(received.flags["output"], PathSpec)
        output = FlagView(received.flags, spec=received.spec).as_paths(
            "output"
        )
        assert [(path.virtual, path.raw_path) for path in output] == [
            (f"/work/{expected_output}", f"./{expected_output}")
        ]


@pytest.mark.asyncio
async def test_a_sync_leaf_runs_like_an_async_one():
    stdout, io, node = await handle_cli(
        make_sync_install(send_sync), ["prog", "go"], SessionState("t")
    )
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sync[tok]\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_a_sync_leaf_that_raises_lands_in_the_generic_arm():
    _, io, node = await handle_cli(
        make_sync_install(raise_sync), ["prog", "go"], SessionState("t")
    )
    assert io.exit_code == 1
    assert io.stderr == b"prog go: sync boom\n"
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_a_leaf_that_fails_after_printing_keeps_what_it_printed():
    stdout, io, node = await handle_cli(
        make_sync_install(raise_after_output),
        ["prog", "go"],
        SessionState("t"),
    )
    assert await materialize(stdout) == b"first\n"
    assert (io.exit_code, io.stderr) == (1, b"prog go: late boom\n")
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_unknown_verb_is_git_worded_exit_1():
    install = make_install("renamed")
    _, io, node = await handle_cli(
        install, ["renamed", "bogus"], SessionState("t")
    )
    assert io.exit_code == 1
    assert io.stderr == (
        b"renamed: 'bogus' is not a renamed command. See 'renamed --help'.\n"
    )
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_bare_group_prints_usage_stdout_exit_1():
    install = make_install()
    stdout, io, _ = await handle_cli(
        install, ["prog", "message"], SessionState("t")
    )
    assert io.exit_code == 1
    out = await materialize(stdout)
    assert b"usage: prog message" in out
    assert b"send" in out


@pytest.mark.asyncio
async def test_leaf_help_prints_installed_prog_exit_0():
    install = make_install("renamed")
    stdout, io, _ = await handle_cli(
        install, ["renamed", "message", "send", "--help"], SessionState("t")
    )
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"usage: renamed message send ")
    assert b"--help" in out


@pytest.mark.asyncio
async def test_leaf_usage_error_exits_2_with_prog_attribution():
    install = make_install()
    _, io, _ = await handle_cli(
        install, ["prog", "message", "send", "hi"], SessionState("t")
    )
    assert io.exit_code == 2
    assert io.stderr.startswith(
        b"prog message send: option '--to' is required"
    )
    _, io, _ = await handle_cli(
        install,
        ["prog", "message", "send", "-t", "a", "--style=x"],
        SessionState("t"),
    )
    assert io.exit_code == 2
    assert io.stderr == (
        b"prog message send: invalid argument 'x' for '--style'\n"
        b"Valid arguments are:\n  - 'top'\n  - 'bottom'\n"
        b"Try 'prog message send --help' for more information.\n"
    )


async def own_help(config: None, paths, texts, ctx: Context):
    return f"help={ctx.flags.get('help')!r}\n".encode(), IOResult()


@pytest.mark.asyncio
async def test_leaf_declaring_help_is_handed_the_flag():
    # Injection is skipped for a leaf that declares --help, so the
    # answer is the leaf's too: intercepting it anyway would make the
    # declaration unreachable.
    spec = CLI(
        spec=CommandSpec(
            name="prog",
            arguments=(
                Argument("--help", action="store_true", help="own help"),
            ),
        ),
        handlers={"": CLIHandler(fn=own_help)},
    )
    install = CLIInstall(name="prog", cli=spec, config=None)
    stdout, io, _ = await handle_cli(
        install, ["prog", "--help"], SessionState("t")
    )
    assert io.exit_code == 0
    assert await materialize(stdout) == b"help=True\n"


async def slow_send(config: None, paths, texts, ctx: Context):
    await asyncio.sleep(0.5)
    return None, IOResult()


@pytest.mark.asyncio
async def test_leaf_limit_bounds_the_handler():
    # The declared limit wraps the handler body like mount
    # dispatch: a blocking leaf times out instead of hanging.
    spec = CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="run"),)),
        handlers={
            "run": CLIHandler(fn=slow_send, limit=Limit(timeout_seconds=0.05))
        },
    )
    install = CLIInstall(name="prog", cli=spec, config=None)
    with pytest.raises(CommandTimeoutError, match="prog run"):
        await handle_cli(install, ["prog", "run"], SessionState("t"))


@pytest.mark.asyncio
async def test_a_timed_out_write_still_drops_the_caches():
    # asyncio cancels the leaf, but a request it already sent may have
    # been accepted, and the service will not roll it back.
    dropped = []

    async def drop():
        dropped.append(True)

    spec = CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="run"),)),
        handlers={
            "run": CLIHandler(
                fn=slow_send, write=True, limit=Limit(timeout_seconds=0.05)
            )
        },
        config_model=TokenConfig,
    )
    install = token_install("prog", spec, "t")
    with pytest.raises(CommandTimeoutError):
        await handle_cli(
            install, ["prog", "run"], SessionState("t"), drop_caches=drop
        )
    assert dropped == [True]


@pytest.mark.asyncio
async def test_a_canceled_write_still_drops_the_caches():
    dropped = []
    entered = asyncio.Event()

    async def drop():
        dropped.append(True)

    async def send(config, paths, texts, ctx):
        entered.set()
        await asyncio.Event().wait()

    spec = CLI(
        spec=CommandSpec(name="prog", subcommands=(CommandSpec(name="run"),)),
        handlers={"run": CLIHandler(fn=send, write=True)},
        config_model=TokenConfig,
    )
    install = token_install("prog", spec, "t")
    calling = asyncio.create_task(
        handle_cli(
            install, ["prog", "run"], SessionState("t"), drop_caches=drop
        )
    )
    await entered.wait()
    calling.cancel()
    with pytest.raises(asyncio.CancelledError):
        await calling
    assert dropped == [True]


@pytest.mark.asyncio
async def test_stdin_rides_the_invocation_record():
    # stdin is a field of the one Context, never a synthetic
    # flag: a leaf declaring its own --stdin option can no longer be
    # clobbered by piped input.
    CALLS.clear()
    install = make_install()
    await handle_cli(
        install,
        ["prog", "message", "send", "-t", "x"],
        SessionState("t"),
        stdin=b"body",
    )
    ctx = CALLS.pop()[3]
    assert ctx.stdin == b"body"
    assert "stdin" not in ctx.flags


@pytest.mark.asyncio
async def test_the_session_cwd_rides_the_invocation_record():
    CALLS.clear()
    await handle_cli(
        make_install(),
        ["prog", "message", "send", "-t", "x"],
        SessionState(session_id="t", cwd="/data"),
    )
    assert CALLS.pop()[3].cwd.virtual == "/data"


def _seen(program: Program, ctx: Context) -> SimpleNamespace:
    env = ctx.env or {}
    return SimpleNamespace(**asdict(program), env=env, flags=ctx.flags)


class FakePyRuntime(LanguageRuntime):
    name = "fakepy"
    language = "python"

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[SimpleNamespace] = []
        self.result = RunResult(stdout=b"ran\n", stderr=None, exit_code=0)

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        self.seen.append(_seen(program, ctx))
        return self.result


class OtherPyRuntime(FakePyRuntime):
    name = "otherpy"


class FakeJsRuntime(FakePyRuntime):
    name = "fakejs"
    language = "js"


class CrashingRuntime(FakePyRuntime):
    name = "crashpy"

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        raise RuntimeError("engine exploded")


class SleepingRuntime(FakePyRuntime):
    name = "sleepy"
    cancelled = False

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        try:
            await asyncio.sleep(0.5)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return self.result


def script_install(
    runtime: str | None = None,
    config: dict | None = None,
    language: str = "python",
    options: tuple[Argument, ...] = (),
) -> CLIInstall:
    spec = CLI(
        spec=CommandSpec(name="pager", arguments=(*options,)),
        script=ScriptSource("print('hi')", language=language),
        runtime=runtime,
    )
    return CLIInstall(name="pager", cli=spec, config=config)


@pytest.mark.asyncio
async def test_script_selects_by_language_and_runs():
    # The python script lands on the python-speaking entry even though
    # a js entry sits first in the world; argv reaches the program
    # verbatim so it can re-parse natively.
    py, js = FakePyRuntime(), FakeJsRuntime()
    install = script_install()
    stdout, io, node = await handle_cli(
        install,
        ["pager", "report.txt", "x"],
        SessionState("t"),
        context=CLIContext(entries=[js, py]),
    )
    assert io.exit_code == 0
    assert await materialize(stdout) == b"ran\n"
    assert js.seen == []
    run = py.seen.pop()
    assert run.code == "print('hi')"
    assert run.args == ["report.txt", "x"]
    assert node.command == "pager report.txt x"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_script_declared_options_still_pass_verbatim():
    # The spec is a typed entry point: a declared option validates, then
    # the program still receives the raw tokens, the contract a native
    # binary could also honor.
    py = FakePyRuntime()
    install = script_install(options=(Argument("-n", "--lines", type="int"),))
    _, io, _ = await handle_cli(
        install,
        ["pager", "-n", "3", "report.txt"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 0
    assert py.seen.pop().args == ["-n", "3", "report.txt"]


@pytest.mark.asyncio
async def test_script_module_bit_reaches_the_runtime_as_a_flag():
    # A .mjs source only runs as an ES module if the engine gets
    # flags['module']; without it import and top-level await fail.
    js = FakeJsRuntime()
    spec = CLI(
        spec=CommandSpec(name="pager"),
        script=ScriptSource("export const x = 1", language="js", module=True),
    )
    install = CLIInstall(name="pager", cli=spec, config=None)
    _, io, _ = await handle_cli(
        install, ["pager"], SessionState("t"), context=CLIContext(entries=[js])
    )
    assert io.exit_code == 0
    assert js.seen.pop().flags.get("module") is True


@pytest.mark.asyncio
async def test_script_without_the_module_bit_sends_no_module_flag():
    py = FakePyRuntime()
    await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    flags = py.seen.pop().flags
    assert "module" not in flags
    assert flags["script_cli"] is True


@pytest.mark.asyncio
async def test_script_env_carries_mirage_config_json():
    py = FakePyRuntime()
    install = script_install(config={"api_key": "k1"})
    session = SessionState("t")
    seed_var(session, "EDITOR", "vi")
    # Exported: `ctx.env` is the process view a CLI receives, which
    # carries exported names only, the way a child process's environ
    # does. A plain shell variable is deliberately not in it.
    set_attr(session, "EDITOR", VarAttr.EXPORT)
    _, io, _ = await handle_cli(
        install, ["pager"], session, context=CLIContext(entries=[py])
    )
    assert io.exit_code == 0
    run = py.seen.pop()
    assert run.env == {
        "EDITOR": "vi",
        "PWD": "/",
        "MIRAGE_CLI_CONFIG": '{"api_key": "k1"}',
    }


@pytest.mark.asyncio
async def test_script_env_omits_mirage_config_without_config():
    py = FakePyRuntime()
    _, _, _ = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert "MIRAGE_CLI_CONFIG" not in py.seen.pop().env


@pytest.mark.asyncio
async def test_script_is_named_by_its_installed_head_word():
    # The program's own name rides argv slot 0, so its messages read
    # 'pager:' and two installs of one program are distinguishable.
    py = FakePyRuntime()
    install = CLIInstall(name="renamed", cli=script_install().cli, config=None)
    await handle_cli(
        install,
        ["renamed", "report.txt"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    run = py.seen.pop()
    assert run.prog == "renamed"
    assert run.args == ["report.txt"]


@pytest.mark.asyncio
async def test_script_stdin_materializes_to_bytes():
    py = FakePyRuntime()
    await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        stdin=b"body",
        context=CLIContext(entries=[py]),
    )
    assert py.seen.pop().stdin == b"body"


@pytest.mark.asyncio
async def test_script_help_reaches_a_program_that_declared_nothing():
    # A grammarless script root answers its own --help: mirage would
    # render a page documenting only --help, which documents nothing.
    py = FakePyRuntime()
    _, io, _ = await handle_cli(
        script_install(),
        ["pager", "--help"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 0
    assert py.seen.pop().args == ["--help"]


@pytest.mark.asyncio
async def test_script_help_renders_when_the_spec_declares_a_grammar():
    # Declaring options opts back into the entry point, where the
    # rendered page is truthful and the program never runs.
    py = FakePyRuntime()
    install = script_install(options=(Argument("-n", "--lines", type="int"),))
    stdout, io, _ = await handle_cli(
        install,
        ["pager", "--help"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"usage: pager ")
    assert b"--lines" in out
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_undeclared_flag_reaches_the_program():
    # The program is the parser, so a flag it accepts must not be
    # refused on its behalf: a yaml clis entry declares no grammar at
    # all, which would leave the tier operand-only.
    py = FakePyRuntime()
    _, io, _ = await handle_cli(
        script_install(),
        ["pager", "--width", "80", "-n", "x"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 0
    assert py.seen.pop().args == ["--width", "80", "-n", "x"]


@pytest.mark.asyncio
async def test_script_with_a_grammar_refuses_an_undeclared_flag():
    py = FakePyRuntime()
    install = script_install(options=(Argument("-n", "--lines", type="int"),))
    _, io, _ = await handle_cli(
        install,
        ["pager", "--frobnicate"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 2
    assert io.stderr.startswith(b"pager: unrecognized option '--frobnicate'")
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_runtime_pin_is_honored():
    # The pin overrides first-match: the named entry runs the script
    # even when an earlier entry speaks the same language.
    first, pinned = FakePyRuntime(), OtherPyRuntime()
    install = script_install(runtime="otherpy")
    _, io, _ = await handle_cli(
        install,
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[first, pinned]),
    )
    assert io.exit_code == 0
    assert first.seen == []
    assert len(pinned.seen) == 1


class TierPyRuntime(PythonRuntime):
    def __init__(self, name: str) -> None:
        super().__init__()
        self.name = name
        self.seen: list[SimpleNamespace] = []

    async def interpret(self, engine, program: Program, ctx) -> RunResult:
        self.seen.append(_seen(program, ctx))
        return RunResult(stdout=b"ran\n", stderr=None, exit_code=0)


class LineBox(Runtime):
    name = "box"


@pytest.mark.asyncio
async def test_script_runs_where_the_line_runs_its_interpreter():
    # A route policy or a runtime's script that places this line's
    # python3 on the second entry places the script there too.
    first, second = TierPyRuntime("first"), TierPyRuntime("second")
    routing = RouteDecision(bindings={"python3": second, "python": second})
    _, io, _ = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[first, second], routing=routing),
    )
    assert io.exit_code == 0
    assert first.seen == []
    assert len(second.seen) == 1


@pytest.mark.asyncio
async def test_script_is_refused_when_the_line_refused_its_interpreter():
    py = TierPyRuntime("first")
    _, io, node = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(
            entries=[py], routing=RouteDecision(bindings={"python3": None})
        ),
    )
    assert io.exit_code == 126
    assert io.stderr == b"pager: no runtime accepted this line\n"
    assert node.exit_code == 126
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_is_refused_where_the_line_runs_python3_without_python():
    # A line whose python3 runs inside a sandbox runs no script there, and
    # the entry the line passed over does not run it either.
    py = TierPyRuntime("first")
    _, io, _ = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(
            entries=[py],
            routing=RouteDecision(bindings={"python3": LineBox()}),
        ),
    )
    assert io.exit_code == 127
    assert io.stderr == b"pager: runtime 'box' does not run python scripts\n"
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_runs_on_the_first_entry_where_the_workspace_serves_python3():
    py = TierPyRuntime("first")
    _, io, _ = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(
            entries=[py], routing=RouteDecision(fallback=WorkspaceRuntime())
        ),
    )
    assert io.exit_code == 0
    assert len(py.seen) == 1


@pytest.mark.asyncio
async def test_script_unknown_pin_exits_127():
    py = FakePyRuntime()
    _, io, node = await handle_cli(
        script_install(runtime="local"),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 127
    assert io.stderr == (
        b"pager: unknown runtime: 'local' (workspace runtimes: 'fakepy')\n"
    )
    assert node.exit_code == 127
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_pin_language_mismatch_exits_127():
    js = FakeJsRuntime()
    _, io, _ = await handle_cli(
        script_install(runtime="fakejs"),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[js]),
    )
    assert io.exit_code == 127
    assert io.stderr == (
        b"pager: runtime 'fakejs' does not run python scripts\n"
    )
    assert js.seen == []


@pytest.mark.asyncio
async def test_script_no_language_match_exits_127():
    py = FakePyRuntime()
    _, io, _ = await handle_cli(
        script_install(language="js"),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert io.exit_code == 127
    assert io.stderr == (
        b"pager: no workspace runtime runs js scripts "
        b"(workspace runtimes: 'fakepy')\n"
    )


@pytest.mark.asyncio
async def test_script_outside_a_workspace_exits_127():
    _, io, _ = await handle_cli(script_install(), ["pager"], SessionState("t"))
    assert io.exit_code == 127
    assert io.stderr == (
        b"pager: no workspace runtime runs python scripts "
        b"(workspace runtimes: none)\n"
    )


@pytest.mark.asyncio
async def test_script_crash_reports_prog_prefixed_exit_1():
    crash = CrashingRuntime()
    _, io, _ = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[crash]),
    )
    assert io.exit_code == 1
    assert io.stderr == b"pager: engine exploded\n"


@pytest.mark.asyncio
async def test_script_exit_code_and_stderr_surface():
    py = FakePyRuntime()
    py.result = RunResult(stdout=b"", stderr=b"boom\n", exit_code=3)
    stdout, io, node = await handle_cli(
        script_install(),
        ["pager"],
        SessionState("t"),
        context=CLIContext(entries=[py]),
    )
    assert stdout is None
    assert io.exit_code == 3
    assert io.stderr == b"boom\n"
    assert node.exit_code == 3


@pytest.mark.asyncio
async def test_script_limit_bounds_the_run():
    sleepy = SleepingRuntime()
    spec = CLI(
        spec=CommandSpec(name="pager"),
        handlers={"": CLIHandler(limit=Limit(timeout_seconds=0.05))},
        script=ScriptSource("print('hi')"),
    )
    install = CLIInstall(name="pager", cli=spec, config=None)
    with pytest.raises(CommandTimeoutError, match="pager"):
        await handle_cli(
            install,
            ["pager"],
            SessionState("t"),
            context=CLIContext(entries=[sleepy]),
        )
    assert sleepy.cancelled


def test_env_fills_an_option_the_line_omitted():
    spec = CommandSpec(arguments=(Argument("--version", env="X_VERSION"),))
    parsed = parse_flags([], spec, "x", "/", env={"X_VERSION": "9"})
    assert parsed.flag_kwargs == {"version": "9"}


def test_the_typed_value_wins_over_the_environment():
    spec = CommandSpec(arguments=(Argument("--version", env="X_VERSION"),))
    parsed = parse_flags(
        ["--version", "typed"], spec, "x", "/", env={"X_VERSION": "9"}
    )
    assert parsed.flag_kwargs == {"version": "typed"}


def test_the_environment_wins_over_a_declared_default():
    spec = CommandSpec(
        arguments=(Argument("--version", default="fallback", env="X_VERSION"),)
    )
    assert parse_flags(
        [], spec, "x", "/", env={"X_VERSION": "9"}
    ).flag_kwargs == {"version": "9"}
    assert parse_flags([], spec, "x", "/", env={}).flag_kwargs == {
        "version": "fallback"
    }


def test_env_satisfies_a_required_option_before_it_is_refused():
    # The whole point of filling inside the parse: the option is
    # credited against required, so the line is not refused.
    spec = CommandSpec(
        arguments=(Argument("--version", env="X_VERSION", required=True),)
    )
    filled = parse_flags([], spec, "x", "/", env={"X_VERSION": "9"})
    assert filled.missing_required_options == []
    assert option_error("x", filled) is None


def test_an_unset_variable_leaves_the_refusal_standing():
    spec = CommandSpec(
        arguments=(Argument("--version", env="X_VERSION", required=True),)
    )
    same = parse_flags([], spec, "x", "/", env={})
    assert same.missing_required_options == ["--version"]
    assert option_error("x", same) is not None


def test_an_env_value_is_coerced_and_checked_like_a_typed_one():
    # Filling after the parse left these unchecked: an int stayed a
    # string nobody validated and a choice was never tested.
    ints = CommandSpec(
        arguments=(Argument("--count", type="int", env="X_COUNT"),)
    )
    assert (
        option_error(
            "x", parse_flags([], ints, "x", "/", env={"X_COUNT": "nope"})
        )
        is not None
    )
    assert (
        option_error(
            "x", parse_flags([], ints, "x", "/", env={"X_COUNT": "4"})
        )
        is None
    )
    picks = CommandSpec(
        arguments=(Argument("--mode", choices=("a", "b"), env="X_MODE"),)
    )
    assert (
        option_error(
            "x", parse_flags([], picks, "x", "/", env={"X_MODE": "zzz"})
        )
        is not None
    )
    assert (
        option_error(
            "x", parse_flags([], picks, "x", "/", env={"X_MODE": "a"})
        )
        is None
    )


def test_an_env_path_becomes_a_pathspec_like_a_typed_one():
    # A raw string here vanished from FlagView.as_paths() and was never
    # routed to a mount.
    spec = CommandSpec(
        arguments=(Argument("--conf", type="path", env="X_CONF"),)
    )
    parsed = parse_flags([], spec, "x", "/work", env={"X_CONF": "rel.json"})
    value = parsed.flag_kwargs["conf"]
    assert isinstance(value, PathSpec)
    assert value.virtual == "/work/rel.json"


def test_an_env_value_does_not_count_as_typed():
    # clap's usage line echoes what the line carried; an env-supplied
    # option is supplied but not typed, and clap_supplied reads the
    # environment itself for that distinction.
    spec = CommandSpec(arguments=(Argument("--version", env="X_VERSION"),))
    parsed = parse_command(spec, [], "/", env={"X_VERSION": "9"})
    assert parsed.flags["--version"] == "9"
    assert parsed.typed_dests == []


class DenyAwsWrites(Policy):
    """Refuses any session write naming an AWS variable."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.key.startswith("AWS_"):
            return Deny("not yours to set\n")
        return None


async def stash(config: None, paths, texts, ctx: Context):
    """A leaf that writes the session plane through its entry point."""
    view = ctx.session
    if view is None:
        return b"no session plane\n", IOResult(exit_code=1)
    await view.set(texts[0], texts[1])
    return f"{texts[0]}={view.get(texts[0])}\n".encode(), IOResult()


STASH = CLI(
    spec=CommandSpec(
        name="stash", arguments=(Argument("texts", nargs="*", metavar=""),)
    ),
    handlers={"": CLIHandler(fn=stash)},
)


@pytest.mark.asyncio
async def test_a_leaf_writes_the_session_through_its_entry_point():
    # The session view is what a registered CLI has instead of
    # reaching into the session: the write lands, and the shell sees it.
    with Workspace({"/ram/": RAMVFS()}) as ws:
        ws.register_cli("stash", STASH)
        result = await ws.shell("stash TOKEN abc")
        assert result.exit_code == 0
        assert result.stdout == b"TOKEN=abc\n"
        echoed = await ws.shell("echo $TOKEN")
        assert echoed.stdout == b"abc\n"


@pytest.mark.asyncio
async def test_a_leafs_session_write_clears_the_same_gate_the_shell_does():
    # An entry point that skipped the gate would make an installed CLI the way
    # around every pre_session rule, which is the whole reason writes
    # go through one entry point rather than to the session.
    with Workspace({"/ram/": RAMVFS()}, policies=[DenyAwsWrites()]) as ws:
        ws.register_cli("stash", STASH)
        denied = await ws.shell("stash AWS_PROFILE prod")
        assert denied.exit_code != 0
        assert denied.refusal and "not yours to set" in denied.refusal.reason
        assert (await ws.shell("echo $AWS_PROFILE")).stdout == b"\n"
        allowed = await ws.shell("stash OTHER fine")
        assert allowed.exit_code == 0


def _out_of_band_writer(root):
    """A leaf that reaches its service past every mount, as an account
    CLI does: the file lands on disk, and no vfs path was touched."""

    async def leaf(config, paths, texts, ctx: Context):
        (root / "made.txt").write_bytes(b"made\n")
        return b"ok\n", IOResult()

    return leaf


def _disk_workspace(root):
    root.mkdir(exist_ok=True)
    (root / "a.txt").write_bytes(b"v1\n")
    disk = DiskVFS(root=str(root))
    disk.caches_reads = True
    return Workspace({"/data/": disk}, mode=MountMode.WRITE)


async def _warm_then_run(ws: Workspace, root, line: str) -> tuple[str, str]:
    await ws.shell("cat /data/a.txt")
    await ws.shell("ls /data")
    (root / "a.txt").write_bytes(b"v2\n")
    result = await ws.shell(line)
    assert result.exit_code == 0, result.stderr
    body = (await ws.shell("cat /data/a.txt")).stdout.decode()
    listing = (await ws.shell("ls /data")).stdout.decode()
    return body, listing


@pytest.mark.asyncio
async def test_an_account_cli_write_refreshes_every_mount(tmp_path):
    # Nothing on the CLI names the mount and nothing on the mount names
    # the CLI: a write verb on a CLI with a config model is the whole
    # signal, and the next read of any mount refetches.
    root = tmp_path / "svc"
    with _disk_workspace(root) as ws:
        ws.register_cli(
            "acme",
            CLI(
                spec=CommandSpec(
                    name="acme", subcommands=(CommandSpec(name="close"),)
                ),
                handlers={
                    "close": CLIHandler(
                        fn=_out_of_band_writer(root), write=True
                    )
                },
                config_model=TokenConfig,
            ),
            {"token": "t"},
        )
        body, listing = await _warm_then_run(ws, root, "acme close")
        assert body == "v2\n"
        assert "made.txt" in listing


@pytest.mark.asyncio
async def test_an_account_cli_write_refreshes_only_the_mounts_it_reaches(
    tmp_path,
):
    # A client that says which mounts its writes can reach (a gh install
    # reaches only github mounts) costs the others no reload.
    root, apart = tmp_path / "svc", tmp_path / "apart"
    for folder in (root, apart):
        folder.mkdir()
        (folder / "a.txt").write_bytes(b"v1\n")
    served, other = DiskVFS(root=str(root)), DiskVFS(root=str(apart))
    served.caches_reads = other.caches_reads = True
    with Workspace(
        {"/data/": served, "/apart/": other}, mode=MountMode.WRITE
    ) as ws:

        class Client(Accessor):
            def reaches(self, peer: Accessor) -> bool:
                return peer is served.accessor

        ws.register_cli(
            "acme",
            CLI(
                spec=CommandSpec(
                    name="acme", subcommands=(CommandSpec(name="close"),)
                ),
                handlers={
                    "close": CLIHandler(
                        fn=_out_of_band_writer(root), write=True
                    )
                },
                config_model=TokenConfig,
                accessor=lambda config: Client(),
            ),
            {"token": "t"},
        )
        await ws.shell("cat /apart/a.txt")
        (apart / "a.txt").write_bytes(b"v2\n")
        body, listing = await _warm_then_run(ws, root, "acme close")
        assert body == "v2\n"
        assert "made.txt" in listing
        kept = await ws.shell("cat /apart/a.txt")
        assert kept.stdout == b"v1\n"


@pytest.mark.asyncio
async def test_an_account_cli_read_keeps_every_mount_warm(tmp_path):
    root = tmp_path / "svc"
    with _disk_workspace(root) as ws:
        ws.register_cli(
            "acme",
            CLI(
                spec=CommandSpec(
                    name="acme", subcommands=(CommandSpec(name="peek"),)
                ),
                handlers={"peek": CLIHandler(fn=_out_of_band_writer(root))},
                config_model=TokenConfig,
            ),
            {"token": "t"},
        )
        body, listing = await _warm_then_run(ws, root, "acme peek")
        assert body == "v1\n"
        assert "made.txt" not in listing


@pytest.mark.asyncio
async def test_a_mount_tier_cli_write_drops_nothing(tmp_path):
    # A CLI without a config model (git) writes through the dispatcher,
    # which invalidates the paths it touched as it went; a blanket drop
    # would only cost every other mount a reload.
    root = tmp_path / "svc"
    with _disk_workspace(root) as ws:
        ws.register_cli(
            "tool",
            CLI(
                spec=CommandSpec(
                    name="tool", subcommands=(CommandSpec(name="poke"),)
                ),
                handlers={
                    "poke": CLIHandler(
                        fn=_out_of_band_writer(root), write=True
                    )
                },
            ),
        )
        body, listing = await _warm_then_run(ws, root, "tool poke")
        assert body == "v1\n"
        assert "made.txt" not in listing


def test_a_root_with_a_config_model_or_a_script_reaches_a_service():
    # A script root's config is opaque, so it never carries a config
    # model, yet its program may reach a service exactly as an account
    # CLI does; only a root with neither writes through the dispatcher.
    assert reaches_service(make_install().cli)
    assert reaches_service(script_install().cli)
    assert not reaches_service(STASH)


@pytest.mark.asyncio
async def test_git_usage_style_does_not_change_custom_cli_option_grammar():
    spec = CLI(
        spec=CommandSpec(
            name="custom",
            usage_style=UsageStyle.GIT,
            subcommands=(
                CommandSpec(
                    name="branch",
                    arguments=(Argument("--topic", action="store_true"),),
                ),
            ),
        ),
        handlers={"branch": CLIHandler(fn=send)},
        config_model=TokenConfig,
    )
    install = token_install("custom", spec)
    stdout, io, _ = await handle_cli(
        install, ["custom", "branch", "--top"], SessionState("t")
    )
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sent[tok]\n"


@pytest.mark.asyncio
async def test_profile_and_workspace_override_a_cli_deadline():
    spec = CLI(
        spec=CommandSpec(name="prog"),
        handlers={
            "": CLIHandler(fn=slow_send, limit=Limit(timeout_seconds=0.01))
        },
    )
    with Workspace(
        {"/ram": RAMVFS()},
        command_limits={"prog": Limit(timeout_seconds=1)},
        profiles={
            "short": {"command_limits": {"prog": {"timeout_seconds": 0.01}}}
        },
    ) as ws:
        ws.register_cli("prog", spec)
        ws.create_session("short", profile="short")
        assert (await ws.shell("prog")).exit_code == 0
        assert (await ws.shell("prog", session_id="short")).exit_code == 124


@pytest.mark.asyncio
@pytest.mark.parametrize("fails", [False, True])
async def test_invocation_shell_is_revoked_after_handler_settles(fails):
    saved = []
    calls = []

    async def evaluate(line, stdin=None):
        calls.append(line)
        return IOResult()

    async def probe(config, paths, texts, ctx):
        saved.append(ctx.shell)
        await ctx.shell("echo allowed")
        if fails:
            raise RuntimeError("handler failed")
        return None, IOResult()

    spec = CLI(
        spec=CommandSpec(name="probe"), handlers={"": CLIHandler(fn=probe)}
    )
    await handle_cli(
        CLIInstall(name="probe", cli=spec, config=None),
        ["probe"],
        SessionState(session_id="s"),
        context=CLIContext(shell=evaluate),
    )
    with pytest.raises(RuntimeError, match="no longer active"):
        await saved[0]("echo late")
    assert calls == ["echo allowed"]


@pytest.mark.asyncio
async def test_invocation_shell_is_revoked_after_cancellation():
    entered = asyncio.Event()
    saved = []

    async def evaluate(line, stdin=None):
        raise AssertionError("cancelled callback must not run a line")

    async def probe(config, paths, texts, ctx):
        saved.append(ctx.shell)
        entered.set()
        await asyncio.Event().wait()

    spec = CLI(
        spec=CommandSpec(name="probe"), handlers={"": CLIHandler(fn=probe)}
    )
    task = asyncio.create_task(
        handle_cli(
            CLIInstall(name="probe", cli=spec, config=None),
            ["probe"],
            SessionState(session_id="s"),
            context=CLIContext(shell=evaluate),
        )
    )
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    with pytest.raises(RuntimeError, match="no longer active"):
        await saved[0]("echo late")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("nargs", "usage", "style"),
    [
        (None, "ID", UsageStyle.ARGPARSE),
        ("+", "ID ...", UsageStyle.ARGPARSE),
        (2, "ID ID", UsageStyle.ARGPARSE),
        ("?", None, UsageStyle.ARGPARSE),
        (None, "ID", UsageStyle.COBRA),
    ],
)
async def test_argparse_required_positionals_refuse_before_the_handler(
    nargs, usage, style
):
    calls = []

    async def handler(config, paths, texts, ctx):
        calls.append(texts)
        if style is UsageStyle.COBRA:
            raise ValueError("handler requires ID")
        return b"called", IOResult()

    cli = CLI(
        CommandSpec(
            name="tool",
            usage_style=style,
            arguments=(Argument("ID", nargs=nargs),),
        ),
        handlers={"": CLIHandler(handler)},
    )
    install = CLIInstall(name="renamed", cli=cli)
    stdout, io, _ = await handle_cli(install, ["renamed"], SessionState("t"))
    if style is UsageStyle.COBRA:
        assert stdout is None
        assert io.exit_code == 1
        assert (
            await materialize(io.stderr) == b"renamed: handler requires ID\n"
        )
        stdout, io, _ = await handle_cli(
            install, ["renamed", "-h"], SessionState("t")
        )
        assert io.exit_code == 0
        assert (await materialize(stdout)).startswith(
            b"usage: renamed [-h] ID\n"
        )
        assert calls == [[]]
    elif usage is None:
        assert io.exit_code == 0
        assert await materialize(stdout) == b"called"
        assert calls == [[]]
    else:
        assert stdout is None
        assert io.exit_code == 2
        assert (
            await materialize(io.stderr)
            == (
                f"usage: renamed [-h] {usage}\n"
                "renamed: error: the following arguments are required: ID\n"
            ).encode()
        )
        assert calls == []
        stdout, io, _ = await handle_cli(
            install, ["renamed", "--help"], SessionState("t")
        )
        assert io.exit_code == 0
        assert b"ID" in await materialize(stdout)
        assert calls == []


@pytest.mark.asyncio
async def test_native_output_closes_on_early_pipeline_consumer_exit():
    closed = asyncio.Event()

    async def source():
        try:
            while True:
                yield b"x" * 16384
        finally:
            closed.set()

    async def writer(config, paths, texts, ctx):
        return source(), IOResult()

    with Workspace({"/ram": RAMVFS()}, mode="write") as ws:
        ws.register_cli(
            "writer",
            CLI(CommandSpec(name="writer"), handlers={"": CLIHandler(writer)}),
        )
        result = await asyncio.wait_for(ws.shell("writer | head -c 1"), 2)
        assert result.stdout == b"x"
        assert result.exit_code == 0
        assert closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("timeout", [None, 1])
async def test_native_cli_unstarted_output_close_joins_producer(timeout):
    closed = asyncio.Event()

    async def writer(config, paths, texts, ctx):
        return _HeldSource(b"prefix", closed.set), IOResult()

    cli = CLI(
        CommandSpec(name="writer"),
        handlers={
            "": CLIHandler(
                writer,
                limit=Limit(timeout_seconds=timeout)
                if timeout is not None
                else None,
            )
        },
    )
    output, _, _ = await handle_cli(
        CLIInstall(name="writer", cli=cli), ["writer"], SessionState("test")
    )
    await asyncio.wait_for(output.aclose(), 1)
    assert closed.is_set()


class _HeldSource:
    """Yields its bytes once, then waits until it is closed, once."""

    def __init__(self, data, on_close):
        self._data = data
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._data:
            data, self._data = self._data, b""
            return data
        await asyncio.Event().wait()

    async def aclose(self):
        if self._on_close is not None:
            self._on_close()
            self._on_close = None


async def _warning():
    yield b"warn\n"


async def _warns_leaf(config, paths, texts, ctx):
    return b"out\n", IOResult(stderr=_warning())


@command("warns", vfs="ram", spec=CommandSpec())
async def _warns_builtin(accessor, paths, texts, opts):
    return b"out\n", IOResult(stderr=_warning())


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["cli", "mount"])
async def test_the_streamed_stderr_of_a_handler_reaches_the_caller(kind):
    with Workspace({"/ram": RAMVFS()}, mode="write") as ws:
        if kind == "cli":
            ws.register_cli(
                "warns",
                CLI(
                    CommandSpec(name="warns"),
                    handlers={"": CLIHandler(_warns_leaf)},
                ),
            )
        else:
            ws.mount("/ram").register_commands([_warns_builtin])
        await ws.shell("cd /ram")
        result = await ws.shell("warns")
        assert result.stdout == b"out\n"
        assert result.stderr == b"warn\n"


class ClosingAccessor(NOOPAccessor):
    closed = False

    async def close(self) -> None:
        self.closed = True


async def _done_output():
    yield b"done\n"


@pytest.mark.asyncio
async def test_removal_closes_the_accessor_after_the_leaf_and_its_output():
    entered = asyncio.Event()
    finish = asyncio.Event()

    async def stream_when_told(accessor, paths, texts, ctx: Context):
        entered.set()
        await finish.wait()
        return _done_output(), IOResult()

    registry = CLIRegistry()
    install = registry.install(
        "prog",
        CLI(
            spec=CommandSpec(name="prog"),
            handlers={"": CLIHandler(fn=stream_when_told)},
            accessor=ClosingAccessor,
        ),
    )
    running = asyncio.create_task(
        handle_cli(install, ["prog"], SessionState("t"))
    )
    await entered.wait()
    removing = asyncio.create_task(registry.uninstall("prog"))
    await asyncio.sleep(0)
    assert registry.get("prog") is None
    assert not install.accessor.closed
    finish.set()
    stdout, io, _ = await running
    await asyncio.sleep(0)
    assert not install.accessor.closed
    assert await materialize(stdout) == b"done\n"
    await asyncio.wait_for(removing, 1)
    assert install.accessor.closed


# ── a command tree a mount serves ──────────────────────────────


async def _note_show(accessor, paths, texts, ctx):
    out = b""
    for path in paths:
        out += f"{path.raw_path}: ".encode() + await ctx.vfs.read(path)
    return out, IOResult()


async def _note_add(accessor, paths, texts, ctx):
    accessor.store.files["/" + paths[0].vfs_path] = (
        f"tags: {' '.join(texts)}\n".encode()
    )
    return b"tagged\n", IOResult()


NOTE = Argument("note", type="path")
# `add` writes past the dispatcher and declares its own --help.
NOTES = CLI(
    spec=CommandSpec(
        name="notes",
        subcommands=(
            CommandSpec(
                name="show",
                aliases=("ls",),
                arguments=(
                    Argument("-C", type="path", action="append"),
                    Argument("notes", type="path", nargs="+"),
                ),
                operand_base="-C",
            ),
            CommandSpec(
                name="add",
                arguments=(
                    Argument("--help", action="store_true"),
                    NOTE,
                    Argument("tags", nargs="+"),
                ),
            ),
        ),
    ),
    handlers={
        "show": CLIHandler(fn=_note_show),
        "add": CLIHandler(fn=_note_add, write=True),
    },
)


@pytest.mark.parametrize(
    "cli,setting",
    [
        (make_install().cli, "config_model"),
        (
            CLI(
                spec=STASH.spec,
                handlers=STASH.handlers,
                accessor=ClosingAccessor,
            ),
            "accessor",
        ),
        (script_install().cli, "script"),
    ],
)
def test_a_mount_refuses_a_tree_that_brings_its_own_service(cli, setting):
    mount = MountEntry("/data/", RAMVFS())
    with pytest.raises(ValueError, match=f"cli '{cli.spec.name}'.*{setting}"):
        mount.register_commands([cli])


def test_a_mount_serves_a_tree_until_a_command_takes_its_name():
    mount = MountEntry("/data/", RAMVFS())
    mount.register_commands([NOTES])
    assert mount.cli_for("notes") is NOTES
    mount.register_commands(
        [command("notes", vfs=None, spec=CommandSpec())(send)]
    )
    assert mount.cli_for("notes") is None


@pytest.mark.asyncio
async def test_a_mounts_tree_named_like_ls_keeps_its_words():
    # No implied `.`: the tree's walk reads the words as typed.
    tree = CLI(
        spec=CommandSpec(
            name="ls",
            subcommands=(CommandSpec(name="show", arguments=(NOTE,)),),
        ),
        handlers={"show": CLIHandler(fn=_note_show)},
    )
    ws = Workspace({"/n/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        ws.mount("/n/").register_commands([tree])
        helped = await ws.shell("cd /n && ls --help")
        assert helped.exit_code == 0
        assert b"show" in helped.stdout
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_trees_unmatched_glob_is_not_expanded_again_below_its_base():
    # The shell found no q*.md in /n and left the word as typed; -C bases
    # it, and the child mount below /n/b must not expand it a second time.
    ws = Workspace(
        {"/n/": RAMVFS(), "/n/b/sub/": RAMVFS()}, mode=MountMode.WRITE
    )
    try:
        ws.mount("/n/").register_commands([NOTES])
        await ws.shell("mkdir -p /n/b && echo Q > /n/b/q1.md")
        io = await ws.shell("cd /n && notes show -C /n/b q*.md")
        assert (io.exit_code, io.stdout, io.stderr) == (
            1,
            b"",
            b"notes show: /n/b/q*.md: No such file or directory\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_mounts_tree_runs_like_an_installed_cli_on_its_mount():
    vfs = RAMVFS()
    vfs.caches_reads = True
    vfs.accessor.store.files["/a.md"] = b"first\n"
    ws = Workspace({"/n/": vfs, "/o/": RAMVFS()}, mode=MountMode.WRITE)
    stderr = {
        0: b"",
        1: b"notes add: read-only mount at /n/\n",
        126: b"notes: Permission denied\n",
    }
    try:
        ws.mount("/n/").register_commands([NOTES])
        assert (await ws.shell("cat /n/a.md")).stdout == b"first\n"
        shown = await ws.shell("cd /n && notes ls a.md")
        assert (shown.exit_code, shown.stdout) == (0, b"a.md: first\n")
        # Through a link: the leaf is handed the target, as a command is.
        added = await ws.shell("ln -s a.md link.md && notes add link.md work")
        assert (added.exit_code, added.stdout) == (0, b"tagged\n")
        assert (await ws.shell("cat /n/a.md")).stdout == b"tags: work\n"
        # One spelling, two files: each operand keeps its own -C.
        await ws.shell("mkdir a b && echo A > a/f && echo B > b/f")
        two = await ws.shell("notes show -C /n/a f -C /n/b f")
        assert two.stdout == b"f: A\nf: B\n"
        # A glob resolves before the walk, as an installed CLI's does.
        globbed = await ws.shell("notes show /n/*/f")
        assert globbed.stdout == b"/n/a/f: A\n/n/b/f: B\n"
        # So does one in a text slot; a quoted one stays as typed.
        await ws.shell("touch x.tag y.tag && notes add b/f *.tag '*.tag'")
        assert vfs.accessor.store.files["/b/f"] == b"tags: x.tag y.tag *.tag\n"
        # An option's value spelled like the operand stays the option's.
        await ws.shell("echo AA > a/a")
        assert (await ws.shell("notes show -C a a")).stdout == b"a: AA\n"
        # The glob searches the working directory; -C bases what matched.
        await ws.shell("echo B-a > b/a.md && echo B-z > b/z.md")
        based = await ws.shell("notes show -C /n/b [az].md")
        assert based.stdout == b"a.md: B-a\n"
        # Matching nothing there, the word stays as typed, read under -C.
        await ws.shell("echo Q > 'b/q*.md'")
        unmatched = await ws.shell("notes show -C /n/b q*.md")
        assert unmatched.stdout == b"q*.md: Q\n"
        # The leaf keys /n/'s accessor, so another mount's file is refused.
        foreign = await ws.shell("notes add /o/a.md work")
        assert (foreign.exit_code, foreign.stderr) == (
            1,
            b"notes add: /o/a.md: not on /n/, the mount serving notes\n",
        )
        ws.set_mount_mode("/n/", MountMode.READ)
        ws.create_session("hidden", profile={"paths": {"hide": ["/n/x"]}})
        rule = {"reason": "no tagging", "commands": ["notes add"]}
        ws.create_session("ruled", profile={"commands": {"deny": [rule]}})
        for line, session, code in (
            ("notes show /n/a.md", None, 0),
            ("notes add /n/a.md w", None, 1),
            ("notes add /n/a.md w --help", None, 1),
            ("notes show /n/a.md", "hidden", 0),
            ("notes ls /n/a.md", "ruled", 0),
            ("notes add /n/a.md w", "ruled", 126),
        ):
            io = await ws.shell(line, session_id=session)
            got = (io.exit_code, io.stderr or b"")
            assert got == (code, stderr[code]), line
        assert vfs.accessor.store.files["/a.md"] == b"tags: work\n"
    finally:
        await ws.close()
