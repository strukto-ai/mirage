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

from mirage.commands.builtin.utils.limit import CommandTimeoutError
from mirage.commands.cli.types import CLIInvocation, CLISpec
from mirage.commands.spec.types import Operand, Option
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.runtime.base import Runtime
from mirage.runtime.types import RunArgs, RunResult, ScriptSource
from mirage.types import Limit
from mirage.workspace.cli.types import CLIInstall
from mirage.workspace.executor.command.cli import handle_cli
from mirage.workspace.session import Session


class TokenConfig(BaseModel):
    token: str


CALLS: list[dict] = []


async def send(inv: CLIInvocation[TokenConfig]):
    CALLS.append(inv)
    return f"sent[{inv.config.token}]\n".encode(), IOResult()


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
    session.env["EDITOR"] = "vi"
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
    assert inv.env == {"EDITOR": "vi"}
    assert node.command == "prog -vv message send -t #eng hello world"


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


class FakePyRuntime(Runtime):
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
                                        entries=[js, py])
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
                                entries=[py])
    assert io.exit_code == 0
    assert py.seen.pop().args == ["-n", "3", "report.txt"]


@pytest.mark.asyncio
async def test_script_env_carries_mirage_config_json():
    py = FakePyRuntime()
    install = script_install(config={"api_key": "k1"})
    session = Session("t")
    session.env["EDITOR"] = "vi"
    _, io, _ = await handle_cli(install, ["pager"], session, entries=[py])
    assert io.exit_code == 0
    run = py.seen.pop()
    assert run.env == {"EDITOR": "vi", "MIRAGE_CONFIG": '{"api_key": "k1"}'}


@pytest.mark.asyncio
async def test_script_env_omits_mirage_config_without_config():
    py = FakePyRuntime()
    _, _, _ = await handle_cli(script_install(), ["pager"],
                               Session("t"),
                               entries=[py])
    assert "MIRAGE_CONFIG" not in py.seen.pop().env


@pytest.mark.asyncio
async def test_script_stdin_materializes_to_bytes():
    py = FakePyRuntime()
    await handle_cli(script_install(), ["pager"],
                     Session("t"),
                     stdin=b"body",
                     entries=[py])
    assert py.seen.pop().stdin == b"body"


@pytest.mark.asyncio
async def test_script_help_renders_without_executing():
    py = FakePyRuntime()
    stdout, io, _ = await handle_cli(script_install(), ["pager", "--help"],
                                     Session("t"),
                                     entries=[py])
    assert io.exit_code == 0
    out = await materialize(stdout)
    assert out.startswith(b"pager\n")
    assert py.seen == []


@pytest.mark.asyncio
async def test_script_undeclared_flag_refuses_without_executing():
    py = FakePyRuntime()
    _, io, _ = await handle_cli(script_install(), ["pager", "--frobnicate"],
                                Session("t"),
                                entries=[py])
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
                                entries=[first, pinned])
    assert io.exit_code == 0
    assert first.seen == []
    assert len(pinned.seen) == 1


@pytest.mark.asyncio
async def test_script_unknown_pin_exits_127():
    py = FakePyRuntime()
    _, io, node = await handle_cli(script_install(runtime="local"), ["pager"],
                                   Session("t"),
                                   entries=[py])
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
                                entries=[js])
    assert io.exit_code == 127
    assert io.stderr == (b"pager: runtime 'fakejs' does not run "
                         b"python scripts\n")
    assert js.seen == []


@pytest.mark.asyncio
async def test_script_no_language_match_exits_127():
    py = FakePyRuntime()
    _, io, _ = await handle_cli(script_install(language="js"), ["pager"],
                                Session("t"),
                                entries=[py])
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
                                entries=[crash])
    assert io.exit_code == 1
    assert io.stderr == b"pager: engine exploded\n"


@pytest.mark.asyncio
async def test_script_exit_code_and_stderr_surface():
    py = FakePyRuntime()
    py.result = RunResult(stdout=b"", stderr=b"boom\n", exit_code=3)
    stdout, io, node = await handle_cli(script_install(), ["pager"],
                                        Session("t"),
                                        entries=[py])
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
        await handle_cli(install, ["pager"], Session("t"), entries=[sleepy])
