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
from pydantic import BaseModel

from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.errors import CommandTimeoutError
from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import CommandSpec, Operand, Option
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import Action, Deny, Policy
from mirage.policy.types import SessionContext
from mirage.resource.ram import RAMResource
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.types import RunArgs, RunResult, ScriptSource
from mirage.shell.variable import VarAttr
from mirage.types import Limit, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.cli import CLIContext, handle_cli
from mirage.workspace.executor.command.flags import option_error, parse_flags
from mirage.workspace.session import Session
from mirage.workspace.session.state import seed_var, set_attr


class TokenConfig(BaseModel):
    token: str


CALLS: list[dict] = []


async def send(inv: CLIInvocation[TokenConfig]):
    CALLS.append(inv)
    return f"sent[{inv.config.token}]\n".encode(), IOResult()


def send_sync(inv: CLIInvocation[TokenConfig]):
    return f"sync[{inv.config.token}]\n".encode(), IOResult()


def raise_sync(inv: CLIInvocation[TokenConfig]):
    raise RuntimeError("sync boom")


def make_sync_install(fn) -> CLIInstall:
    spec = CLISpec(name="prog",
                   config_model=TokenConfig,
                   subcommands=(CLISpec(name="go", fn=fn), ))
    return CLIInstall(name="prog", spec=spec, config=TokenConfig(token="tok"))


def make_install(name: str = "prog") -> CLIInstall:
    spec = CLISpec(
        name="prog",
        config_model=TokenConfig,
        options=(Option(short="-v", long="--verbose", count=True), ),
        subcommands=(CLISpec(name="message",
                             subcommands=(CLISpec(
                                 name="send",
                                 fn=send,
                                 options=(Option(short="-t",
                                                 long="--to",
                                                 type="str",
                                                 required=True), ),
                                 rest=Operand(type="str")), )), ),
    )
    return CLIInstall(name=name, spec=spec, config=TokenConfig(token="tok"))


@pytest.mark.asyncio
async def test_leaf_runs_with_config_group_flags_and_texts():
    CALLS.clear()
    install = make_install()
    parts = ["prog", "-vv", "message", "send", "-t", "#eng", "hello", "world"]
    session = Session("t")
    seed_var(session, "EDITOR", "vi")
    # Exported: `inv.env` is the process view a CLI receives, which
    # carries exported names only, the way a child process's environ
    # does. A plain shell variable is deliberately not in it.
    set_attr(session, "EDITOR", VarAttr.EXPORT)
    stdout, io, node = await handle_cli(install, parts, session)
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sent[tok]\n"
    inv = CALLS.pop()
    assert inv.config.token == "tok"
    assert inv.texts == ("hello", "world")
    assert inv.flags["to"] == "#eng"
    assert inv.flags["verbose"] == 2
    assert inv.argv == ("-vv", "message", "send", "-t", "#eng", "hello",
                        "world")
    # `$PWD` is exported, so a CLI subprocess inherits it as bash's would.
    assert inv.env == {"EDITOR": "vi", "PWD": "/"}
    assert node.command == "prog -vv message send -t #eng hello world"


@pytest.mark.asyncio
async def test_a_sync_leaf_runs_like_an_async_one():
    stdout, io, node = await handle_cli(make_sync_install(send_sync),
                                        ["prog", "go"], Session("t"))
    assert io.exit_code == 0
    assert await materialize(stdout) == b"sync[tok]\n"
    assert node.exit_code == 0


@pytest.mark.asyncio
async def test_a_sync_leaf_that_raises_lands_in_the_generic_arm():
    _, io, node = await handle_cli(make_sync_install(raise_sync),
                                   ["prog", "go"], Session("t"))
    assert io.exit_code == 1
    assert io.stderr == b"prog go: sync boom\n"
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_unknown_verb_is_git_worded_exit_1():
    install = make_install("renamed")
    _, io, node = await handle_cli(install, ["renamed", "bogus"], Session("t"))
    assert io.exit_code == 1
    assert io.stderr == (b"renamed: 'bogus' is not a renamed command. "
                         b"See 'renamed --help'.\n")
    assert node.exit_code == 1


@pytest.mark.asyncio
async def test_bare_group_prints_usage_stdout_exit_1():
    install = make_install()
    stdout, io, _ = await handle_cli(install, ["prog", "message"],
                                     Session("t"))
    assert io.exit_code == 1
    out = await materialize(stdout)
    assert b"Usage: prog message" in out
    assert b"send" in out


@pytest.mark.asyncio
async def test_leaf_help_prints_installed_prog_exit_0():
    install = make_install("renamed")
    stdout, io, _ = await handle_cli(install,
                                     ["renamed", "message", "send", "--help"],
                                     Session("t"))
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"renamed message send\n")
    assert b"--help" in out


@pytest.mark.asyncio
async def test_leaf_usage_error_exits_2_with_prog_attribution():
    install = make_install()
    _, io, _ = await handle_cli(install, ["prog", "message", "send", "hi"],
                                Session("t"))
    assert io.exit_code == 2
    assert io.stderr.startswith(b"prog message send: option '--to' is "
                                b"required")


async def own_help(inv: CLIInvocation[None]):
    return f"help={inv.flags.get('help')!r}\n".encode(), IOResult()


@pytest.mark.asyncio
async def test_leaf_declaring_help_is_handed_the_flag():
    # Injection is skipped for a leaf that declares --help, so the
    # answer is the leaf's too: intercepting it anyway would make the
    # declaration unreachable.
    spec = CLISpec(name="prog",
                   fn=own_help,
                   options=(Option(long="--help", description="own help"), ))
    install = CLIInstall(name="prog", spec=spec, config=None)
    stdout, io, _ = await handle_cli(install, ["prog", "--help"], Session("t"))
    assert io.exit_code == 0
    assert await materialize(stdout) == b"help=True\n"


async def slow_send(inv: CLIInvocation[None]):
    await asyncio.sleep(0.5)
    return None, IOResult()


@pytest.mark.asyncio
async def test_leaf_limit_bounds_the_handler():
    # The declared limit wraps the handler body like mount
    # dispatch: a blocking leaf times out instead of hanging.
    spec = CLISpec(name="prog",
                   subcommands=(CLISpec(name="run",
                                        fn=slow_send,
                                        limit=Limit(timeout_seconds=0.05)), ))
    install = CLIInstall(name="prog", spec=spec, config=None)
    with pytest.raises(CommandTimeoutError, match="prog run"):
        await handle_cli(install, ["prog", "run"], Session("t"))


@pytest.mark.asyncio
async def test_stdin_rides_the_invocation_record():
    # stdin is a field of the one CLIInvocation, never a synthetic
    # flag: a leaf declaring its own --stdin option can no longer be
    # clobbered by piped input.
    CALLS.clear()
    install = make_install()
    await handle_cli(install, ["prog", "message", "send", "-t", "x"],
                     Session("t"),
                     stdin=b"body")
    inv = CALLS.pop()
    assert inv.stdin == b"body"
    assert "stdin" not in inv.flags


class FakePyRuntime(LanguageRuntime):
    name = "fakepy"
    language = "python"

    def __init__(self) -> None:
        super().__init__()
        self.seen: list[RunArgs] = []
        self.result = RunResult(stdout=b"ran\n", stderr=None, exit_code=0)

    async def run(self, args: RunArgs) -> RunResult:
        self.seen.append(args)
        return self.result


class OtherPyRuntime(FakePyRuntime):
    name = "otherpy"


class FakeJsRuntime(FakePyRuntime):
    name = "fakejs"
    language = "js"


class CrashingRuntime(FakePyRuntime):
    name = "crashpy"

    async def run(self, args: RunArgs) -> RunResult:
        raise RuntimeError("engine exploded")


class SleepingRuntime(FakePyRuntime):
    name = "sleepy"

    async def run(self, args: RunArgs) -> RunResult:
        await asyncio.sleep(0.5)
        return self.result


def script_install(
        runtime: str | None = None,
        config: dict | None = None,
        language: str = "python",
        options: tuple[Option, ...] = (),
) -> CLIInstall:
    spec = CLISpec(name="pager",
                   script=ScriptSource("print('hi')", language=language),
                   runtime=runtime,
                   options=options)
    return CLIInstall(name="pager", spec=spec, config=config)


@pytest.mark.asyncio
async def test_script_selects_by_language_and_runs():
    # The python script lands on the python-speaking entry even though
    # a js entry sits first in the world; argv reaches the program
    # verbatim so it can re-parse natively.
    py, js = FakePyRuntime(), FakeJsRuntime()
    install = script_install()
    stdout, io, node = await handle_cli(install, ["pager", "report.txt", "x"],
                                        Session("t"),
                                        context=CLIContext(entries=[js, py]))
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
    # The spec is a typed front door: a declared option validates, then
    # the program still receives the raw tokens, the contract a native
    # binary could also honor.
    py = FakePyRuntime()
    install = script_install(
        options=(Option(short="-n", long="--lines", type="int"), ))
    _, io, _ = await handle_cli(install, ["pager", "-n", "3", "report.txt"],
                                Session("t"),
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 0
    assert py.seen.pop().args == ["-n", "3", "report.txt"]


@pytest.mark.asyncio
async def test_script_module_bit_reaches_the_runtime_as_a_flag():
    # A .mjs source only runs as an ES module if the engine gets
    # flags['module']; without it import and top-level await fail.
    js = FakeJsRuntime()
    spec = CLISpec(name="pager",
                   script=ScriptSource("export const x = 1",
                                       language="js",
                                       module=True))
    install = CLIInstall(name="pager", spec=spec, config=None)
    _, io, _ = await handle_cli(install, ["pager"],
                                Session("t"),
                                context=CLIContext(entries=[js]))
    assert io.exit_code == 0
    assert js.seen.pop().flags == {"module": True}


@pytest.mark.asyncio
async def test_script_without_the_module_bit_sends_no_flags():
    py = FakePyRuntime()
    await handle_cli(script_install(), ["pager"],
                     Session("t"),
                     context=CLIContext(entries=[py]))
    assert py.seen.pop().flags == {}


@pytest.mark.asyncio
async def test_script_env_carries_mirage_config_json():
    py = FakePyRuntime()
    install = script_install(config={"api_key": "k1"})
    session = Session("t")
    seed_var(session, "EDITOR", "vi")
    # Exported: `inv.env` is the process view a CLI receives, which
    # carries exported names only, the way a child process's environ
    # does. A plain shell variable is deliberately not in it.
    set_attr(session, "EDITOR", VarAttr.EXPORT)
    _, io, _ = await handle_cli(install, ["pager"],
                                session,
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 0
    run = py.seen.pop()
    assert run.env == {
        "EDITOR": "vi",
        "PWD": "/",
        "MIRAGE_CLI_CONFIG": '{"api_key": "k1"}'
    }


@pytest.mark.asyncio
async def test_script_env_omits_mirage_config_without_config():
    py = FakePyRuntime()
    _, _, _ = await handle_cli(script_install(), ["pager"],
                               Session("t"),
                               context=CLIContext(entries=[py]))
    assert "MIRAGE_CLI_CONFIG" not in py.seen.pop().env


@pytest.mark.asyncio
async def test_script_is_named_by_its_installed_head_word():
    # The program's own name rides argv slot 0, so its messages read
    # 'pager:' and two installs of one program are distinguishable.
    py = FakePyRuntime()
    install = CLIInstall(name="renamed",
                         spec=script_install().spec,
                         config=None)
    await handle_cli(install, ["renamed", "report.txt"],
                     Session("t"),
                     context=CLIContext(entries=[py]))
    run = py.seen.pop()
    assert run.prog == "renamed"
    assert run.args == ["report.txt"]


@pytest.mark.asyncio
async def test_script_stdin_materializes_to_bytes():
    py = FakePyRuntime()
    await handle_cli(script_install(), ["pager"],
                     Session("t"),
                     stdin=b"body",
                     context=CLIContext(entries=[py]))
    assert py.seen.pop().stdin == b"body"


@pytest.mark.asyncio
async def test_script_help_reaches_a_program_that_declared_nothing():
    # A grammarless script root answers its own --help: mirage would
    # render a page documenting only --help, which documents nothing.
    py = FakePyRuntime()
    _, io, _ = await handle_cli(script_install(), ["pager", "--help"],
                                Session("t"),
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 0
    assert py.seen.pop().args == ["--help"]


@pytest.mark.asyncio
async def test_script_help_renders_when_the_spec_declares_a_grammar():
    # Declaring options opts back into the front door, where the
    # rendered page is truthful and the program never runs.
    py = FakePyRuntime()
    install = script_install(
        options=(Option(short="-n", long="--lines", type="int"), ))
    stdout, io, _ = await handle_cli(install, ["pager", "--help"],
                                     Session("t"),
                                     context=CLIContext(entries=[py]))
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"pager\n")
    assert b"--lines" in out
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_undeclared_flag_reaches_the_program():
    # The program is the parser, so a flag it accepts must not be
    # refused on its behalf: a yaml clis entry declares no grammar at
    # all, which would leave the tier operand-only.
    py = FakePyRuntime()
    _, io, _ = await handle_cli(script_install(),
                                ["pager", "--width", "80", "-n", "x"],
                                Session("t"),
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 0
    assert py.seen.pop().args == ["--width", "80", "-n", "x"]


@pytest.mark.asyncio
async def test_script_with_a_grammar_refuses_an_undeclared_flag():
    py = FakePyRuntime()
    install = script_install(
        options=(Option(short="-n", long="--lines", type="int"), ))
    _, io, _ = await handle_cli(install, ["pager", "--frobnicate"],
                                Session("t"),
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 2
    assert io.stderr.startswith(b"pager: unrecognized option '--frobnicate'")
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_runtime_pin_is_honored():
    # The pin overrides first-match: the named entry runs the script
    # even when an earlier entry speaks the same language.
    first, pinned = FakePyRuntime(), OtherPyRuntime()
    install = script_install(runtime="otherpy")
    _, io, _ = await handle_cli(install, ["pager"],
                                Session("t"),
                                context=CLIContext(entries=[first, pinned]))
    assert io.exit_code == 0
    assert first.seen == []
    assert len(pinned.seen) == 1


@pytest.mark.asyncio
async def test_script_unknown_pin_exits_127():
    py = FakePyRuntime()
    _, io, node = await handle_cli(script_install(runtime="local"), ["pager"],
                                   Session("t"),
                                   context=CLIContext(entries=[py]))
    assert io.exit_code == 127
    assert io.stderr == (b"pager: unknown runtime: 'local' "
                         b"(workspace runtimes: 'fakepy')\n")
    assert node.exit_code == 127
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_pin_language_mismatch_exits_127():
    js = FakeJsRuntime()
    _, io, _ = await handle_cli(script_install(runtime="fakejs"), ["pager"],
                                Session("t"),
                                context=CLIContext(entries=[js]))
    assert io.exit_code == 127
    assert io.stderr == (b"pager: runtime 'fakejs' does not run "
                         b"python scripts\n")
    assert js.seen == []


@pytest.mark.asyncio
async def test_script_no_language_match_exits_127():
    py = FakePyRuntime()
    _, io, _ = await handle_cli(script_install(language="js"), ["pager"],
                                Session("t"),
                                context=CLIContext(entries=[py]))
    assert io.exit_code == 127
    assert io.stderr == (b"pager: no workspace runtime runs js scripts "
                         b"(workspace runtimes: 'fakepy')\n")


@pytest.mark.asyncio
async def test_script_outside_a_workspace_exits_127():
    _, io, _ = await handle_cli(script_install(), ["pager"], Session("t"))
    assert io.exit_code == 127
    assert io.stderr == (b"pager: no workspace runtime runs python scripts "
                         b"(workspace runtimes: none)\n")


@pytest.mark.asyncio
async def test_script_crash_reports_prog_prefixed_exit_1():
    crash = CrashingRuntime()
    _, io, _ = await handle_cli(script_install(), ["pager"],
                                Session("t"),
                                context=CLIContext(entries=[crash]))
    assert io.exit_code == 1
    assert io.stderr == b"pager: engine exploded\n"


@pytest.mark.asyncio
async def test_script_exit_code_and_stderr_surface():
    py = FakePyRuntime()
    py.result = RunResult(stdout=b"", stderr=b"boom\n", exit_code=3)
    stdout, io, node = await handle_cli(script_install(), ["pager"],
                                        Session("t"),
                                        context=CLIContext(entries=[py]))
    assert stdout is None
    assert io.exit_code == 3
    assert io.stderr == b"boom\n"
    assert node.exit_code == 3


@pytest.mark.asyncio
async def test_script_limit_bounds_the_run():
    sleepy = SleepingRuntime()
    spec = CLISpec(name="pager",
                   script=ScriptSource("print('hi')"),
                   limit=Limit(timeout_seconds=0.05))
    install = CLIInstall(name="pager", spec=spec, config=None)
    with pytest.raises(CommandTimeoutError, match="pager"):
        await handle_cli(install, ["pager"],
                         Session("t"),
                         context=CLIContext(entries=[sleepy]))


def test_env_fills_an_option_the_line_omitted():
    spec = CommandSpec(
        options=(Option(long="--version", type="str", env="X_VERSION"), ))
    parsed = parse_flags([], spec, "x", "/", env={"X_VERSION": "9"})
    assert parsed.flag_kwargs == {"version": "9"}


def test_the_typed_value_wins_over_the_environment():
    spec = CommandSpec(
        options=(Option(long="--version", type="str", env="X_VERSION"), ))
    parsed = parse_flags(["--version", "typed"],
                         spec,
                         "x",
                         "/",
                         env={"X_VERSION": "9"})
    assert parsed.flag_kwargs == {"version": "typed"}


def test_the_environment_wins_over_a_declared_default():
    spec = CommandSpec(options=(Option(
        long="--version", type="str", default="fallback", env="X_VERSION"), ))
    assert parse_flags([], spec, "x", "/", env={
        "X_VERSION": "9"
    }).flag_kwargs == {
        "version": "9"
    }
    assert parse_flags([], spec, "x", "/", env={}).flag_kwargs == {
        "version": "fallback"
    }


def test_env_satisfies_a_required_option_before_it_is_refused():
    # The whole point of filling inside the parse: the option is
    # credited against required, so the line is not refused.
    spec = CommandSpec(options=(Option(
        long="--version", type="str", env="X_VERSION", required=True), ))
    filled = parse_flags([], spec, "x", "/", env={"X_VERSION": "9"})
    assert filled.missing_required_options == []
    assert option_error("x", filled) is None


def test_an_unset_variable_leaves_the_refusal_standing():
    spec = CommandSpec(options=(Option(
        long="--version", type="str", env="X_VERSION", required=True), ))
    same = parse_flags([], spec, "x", "/", env={})
    assert same.missing_required_options == ["--version"]
    assert option_error("x", same) is not None


def test_an_env_value_is_coerced_and_checked_like_a_typed_one():
    # Filling after the parse left these unchecked: an int stayed a
    # string nobody validated and a choice was never tested.
    ints = CommandSpec(
        options=(Option(long="--count", type="int", env="X_COUNT"), ))
    assert option_error(
        "x", parse_flags([], ints, "x", "/", env={"X_COUNT":
                                                  "nope"})) is not None
    assert option_error("x",
                        parse_flags([], ints, "x", "/", env={"X_COUNT":
                                                             "4"})) is None
    picks = CommandSpec(options=(
        Option(long="--mode", type="str", choices=("a", "b"), env="X_MODE"), ))
    assert option_error(
        "x", parse_flags([], picks, "x", "/", env={"X_MODE":
                                                   "zzz"})) is not None
    assert option_error("x",
                        parse_flags([], picks, "x", "/", env={"X_MODE":
                                                              "a"})) is None


def test_an_env_path_becomes_a_pathspec_like_a_typed_one():
    # A raw string here vanished from FlagView.as_paths() and was never
    # routed to a mount.
    spec = CommandSpec(
        options=(Option(long="--conf", type="path", env="X_CONF"), ))
    parsed = parse_flags([], spec, "x", "/work", env={"X_CONF": "rel.json"})
    value = parsed.flag_kwargs["conf"]
    assert isinstance(value, PathSpec)
    assert value.virtual == "/work/rel.json"


def test_an_env_value_does_not_count_as_typed():
    # clap's usage line echoes what the line carried; an env-supplied
    # option is supplied but not typed, and clap_supplied reads the
    # environment itself for that distinction.
    spec = CommandSpec(
        options=(Option(long="--version", type="str", env="X_VERSION"), ))
    parsed = parse_command(spec, [], "/", env={"X_VERSION": "9"})
    assert parsed.flags["--version"] == "9"
    assert parsed.typed_dests == []


class DenyAwsWrites(Policy):
    """Refuses any session write naming an AWS variable."""

    async def pre_session(self, ctx: SessionContext) -> Action | None:
        if ctx.key.startswith("AWS_"):
            return Deny("not yours to set\n")
        return None


async def stash(inv: CLIInvocation[None]):
    """A leaf that writes the session plane through its door."""
    view = inv.doors.session_view if inv.doors is not None else None
    if view is None:
        return b"no session plane\n", IOResult(exit_code=1)
    await view.set(inv.texts[0], inv.texts[1])
    return f"{inv.texts[0]}={view.get(inv.texts[0])}\n".encode(), IOResult()


STASH = CLISpec(name="stash", fn=stash, rest=Operand(type="str"))


@pytest.mark.asyncio
async def test_a_leaf_writes_the_session_through_its_door():
    # The session plane's door is what a registered CLI has instead of
    # reaching into the session: the write lands, and the shell sees it.
    with Workspace({"/ram/": RAMResource()}) as ws:
        ws.register_cli("stash", STASH)
        result = await ws.execute("stash TOKEN abc")
        assert result.exit_code == 0
        assert result.stdout == b"TOKEN=abc\n"
        echoed = await ws.execute("echo $TOKEN")
        assert echoed.stdout == b"abc\n"


@pytest.mark.asyncio
async def test_a_leafs_session_write_clears_the_same_gate_the_shell_does():
    # A door that skipped the gate would make an installed CLI the way
    # around every pre_session rule, which is the whole reason writes
    # go through one door rather than to the session.
    with Workspace({"/ram/": RAMResource()}, policies=[DenyAwsWrites()]) as ws:
        ws.register_cli("stash", STASH)
        denied = await ws.execute("stash AWS_PROFILE prod")
        assert denied.exit_code != 0
        assert b"not yours to set" in (denied.stderr or b"")
        assert (await ws.execute("echo $AWS_PROFILE")).stdout == b"\n"
        allowed = await ws.execute("stash OTHER fine")
        assert allowed.exit_code == 0
