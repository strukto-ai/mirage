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
import shlex
from contextlib import asynccontextmanager

import pytest
import yaml

from mirage import EXTERNAL_COMMANDS, Limit, MountMode, RAMResource, Workspace
from mirage.commands.cli.types import CLISpec
from mirage.commands.config import command
from mirage.commands.spec.types import CommandSpec, Operand
from mirage.config import _build_runtime_entries
from mirage.io import IOResult
from mirage.policy import CommandRule
from mirage.policy.builtin.output_cap import DEFAULT_COMMAND_LIMITS
from mirage.policy.rule import RulePolicy
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.python.monty import MontyRuntime
from mirage.runtime.types import ProcessExecution, RunResult, ScriptSource
from mirage.workspace.expand import argv as argv_module
from mirage.workspace.lookup import SHELL_NAMES, Consumer, lookup, lookup_all
from mirage.workspace.session import Session


class ProcessProbe(Runtime, ProcessExecutorMixin):
    name = "probe"
    captures = (EXTERNAL_COMMANDS, )

    def __init__(self, **options):
        super().__init__(**options)
        self.requests: list[ProcessExecution] = []

    async def run_process(self, request: ProcessExecution) -> RunResult:
        self.requests.append(request)
        return RunResult(stdout=request.stdin or b"GPU ready\nother\n",
                         stderr=None,
                         exit_code=0)


class DelayedProcessProbe(ProcessProbe):
    cancelled = False

    async def run_process(self, request: ProcessExecution) -> RunResult:
        self.requests.append(request)
        try:
            await asyncio.sleep(0.15)
            return RunResult(stdout=b"completed\n", stderr=None, exit_code=0)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


@asynccontextmanager
async def workspace(*args, **kwargs):
    ws = Workspace(*args, **kwargs)
    try:
        yield ws
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_external_fallback_preserves_vfs_pipes_and_redirects():
    probe = ProcessProbe()
    async with workspace({"/": RAMResource()},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        result = await ws.execute(
            "printf 'GPU ready\nother\n' | native-tool | grep GPU > /out")
        assert result.exit_code == 0
        assert await result.stdout_str() == ""
        assert await (await
                      ws.execute("cat /out")).stdout_str() == "GPU ready\n"
        assert probe.requests[0].argv == ("native-tool", )
        assert probe.requests[0].stdin == b"GPU ready\nother\n"
        assert len(probe.requests) == 1


@pytest.mark.asyncio
async def test_native_argv_preserves_empty_words_and_interpreter_options():
    probe = ProcessProbe(captures=("python3", EXTERNAL_COMMANDS))
    async with workspace({"/work": RAMResource()},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        await ws.execute("cd /work")
        result = await ws.execute(
            "TOKEN=one python3 -c 'print(1)' -u 'a b' '$(echo literal)' ''")
        assert result.exit_code == 0
        request = probe.requests[0]
        assert request.argv == ("python3", "-c", "print(1)", "-u", "a b",
                                "$(echo literal)", "")
        assert request.cwd.virtual == "/work"
        assert request.env["TOKEN"] == "one"
        await ws.execute("native-tool")
        assert "TOKEN" not in probe.requests[1].env


@pytest.mark.asyncio
async def test_external_globs_expand_against_the_workspace():
    probe = ProcessProbe()
    async with workspace({"/work": RAMResource()},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        await ws.execute("touch /work/a.txt /work/b.txt")
        result = await ws.execute("native-tool /work/*.txt '/work/*.txt'")
        assert result.exit_code == 0
        assert probe.requests[0].argv == ("native-tool", "/work/a.txt",
                                          "/work/b.txt", "/work/*.txt")


@pytest.mark.asyncio
async def test_runtime_refusal_cannot_fall_through_to_external_capture():
    named = ProcessProbe(captures=("native-tool", ), script=lambda ctx: False)
    fallback = ProcessProbe()
    fallback.name = "fallback"
    async with workspace({"/": RAMResource()}, runtimes=[named,
                                                         fallback]) as ws:
        assert (await ws.execute("native-tool")).exit_code == 126
        assert not named.requests and not fallback.requests
        assert (await ws.execute("another-tool")).exit_code == 0
        assert len(fallback.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("captures", [("native-tool", ),
                                      (EXTERNAL_COMMANDS, )],
                         ids=["named", "fallback"])
async def test_refused_external_capture_does_not_expand_globs(
        monkeypatch, captures):
    probe = ProcessProbe(captures=captures, script=lambda ctx: False)
    async with workspace({"/": RAMResource()}, runtimes=[probe]) as ws:
        assert await (await
                      ws.execute("echo mirage")).stdout_str() == "mirage\n"
        await ws.execute("shopt -s failglob")
        resolved = argv_module.resolve_globs
        globbed = False

        async def track_globs(*args, **kwargs):
            nonlocal globbed
            globbed = True
            return await resolved(*args, **kwargs)

        monkeypatch.setattr(argv_module, "resolve_globs", track_globs)
        result = await ws.execute("native-tool /api/*")
        assert result.exit_code == 126
        assert await result.stderr_str(
        ) == "native-tool: no runtime accepted this line\n"
        assert not globbed
        assert not probe.requests


@pytest.mark.asyncio
async def test_shell_function_precedes_external_and_discovery_names_the_route(
):
    probe = ProcessProbe()
    async with workspace({"/": RAMResource()}, runtimes=[probe]) as ws:
        assert await (
            await
            ws.execute("type -t native-tool")).stdout_str() == "external\n"
        await ws.execute("native-tool() { echo function; }")
        assert await (await
                      ws.execute("native-tool")).stdout_str() == "function\n"
        assert not probe.requests


@pytest.mark.parametrize(
    "entry",
    ["- name: sandlock", '- name: sandlock\n  captures: ["@external"]'])
def test_yaml_external_capture_matches_the_sdk_default(entry):
    entries = _build_runtime_entries(yaml.safe_load(entry))
    assert entries[0].captures == (EXTERNAL_COMMANDS, )


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["native-tool", "python3"])
@pytest.mark.parametrize("timeout", [1, 0, None])
async def test_external_mount_timeout_replaces_default(monkeypatch, name,
                                                       timeout):
    monkeypatch.setitem(DEFAULT_COMMAND_LIMITS, name,
                        Limit(timeout_seconds=0.05))
    probe = DelayedProcessProbe(captures=("python3", EXTERNAL_COMMANDS))
    async with workspace({"/": RAMResource()},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        for mount in ws._registry.mounts():
            mount.command_limits[name] = Limit(timeout_seconds=timeout)
        result = await ws.execute(f"PROGRAM={name}; $PROGRAM")
        assert result.exit_code == 0
        assert await result.stdout_str() == "completed\n"
        assert len(probe.requests) == 1
        assert not probe.cancelled


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["default", "mount"])
async def test_external_timeout_cancels_process(monkeypatch, source):
    monkeypatch.setitem(
        DEFAULT_COMMAND_LIMITS,
        "native-tool",
        Limit(timeout_seconds=0.05 if source == "default" else 1),
    )
    overrides = ({
        "native-tool": Limit(timeout_seconds=0.05)
    } if source == "mount" else {})
    probe = DelayedProcessProbe()
    async with workspace({"/": (RAMResource(), MountMode.EXEC, overrides)},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        result = await ws.execute("native-tool")
        assert result.exit_code == 124
        assert "native-tool: timed out after 0.05s" in await result.stderr_str(
        )
        assert len(probe.requests) == 1
        assert probe.cancelled


@pytest.mark.asyncio
async def test_external_timeout_includes_stdin_materialization(monkeypatch):
    monkeypatch.setitem(DEFAULT_COMMAND_LIMITS, "native-tool",
                        Limit(timeout_seconds=0.05))
    cancelled = False

    async def slow_stdin():
        nonlocal cancelled
        try:
            await asyncio.sleep(0.15)
            yield b"late\n"
        finally:
            cancelled = True

    probe = ProcessProbe()
    async with workspace({"/": RAMResource()}, runtimes=[probe]) as ws:
        result = await ws.execute("native-tool", stdin=slow_stdin())
        assert result.exit_code == 124
        assert "native-tool: timed out after 0.05s" in await result.stderr_str(
        )
        assert not probe.requests
        assert cancelled


class ShellProbe(Runtime, LineExecutorMixin):
    name = "shell-probe"

    def __init__(self, **options):
        super().__init__(**options)
        self.lines: list[str] = []

    async def run_line(self, line, stdin, env, cwd):
        self.lines.append(line)
        return RunResult(stdout=b"ok\n", stderr=None, exit_code=0)


@command("trello board list",
         resource="ram",
         spec=CommandSpec(positional=(Operand(), ), rest=Operand(type="str")))
async def board_list(accessor, paths, texts, opts):
    return b"ok\n", IOResult()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize("head, expected", [
    ("trello board list", ("trello", "board", "list")),
    ("'trello board list'", ("trello board list", )),
])
async def test_native_execution_preserves_command_tokens(kind, head, expected):
    probe = kind(captures=("trello board list", ))
    ram = RAMResource()
    ram.register(board_list)
    async with workspace({"/": ram}, runtimes=[probe]) as ws:
        result = await ws.execute(head + " 'a b' '$(echo literal)' ''")
        assert result.exit_code == 0
        tokens = (*expected, "a b", "$(echo literal)", "")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize("head, prefix", [
    ("trello board list", ("trello", "board", "list")),
    ("'trello board list'", ("trello board list", )),
])
@pytest.mark.parametrize("pattern, matches", [
    ("/base/i*", ("/base/inner", )),
    ("/base/*", ("/base/inner", "/base/other")),
])
async def test_boundary_expansion_preserves_command_tokens(
        kind, head, prefix, pattern, matches, monkeypatch):
    probe = kind(captures=("trello board list", ))
    ram = RAMResource()
    ram.register(board_list)
    resolve_globs = argv_module.resolve_globs
    pending = True

    async def defer_once(parts, *args, **kwargs):
        nonlocal pending
        if pending:
            pending = False
            return list(parts)
        return await resolve_globs(parts, *args, **kwargs)

    async with workspace(
        {
            "/": ram,
            "/base/inner": RAMResource(),
            "/base/other": RAMResource(),
        },
            mode=MountMode.EXEC,
            runtimes=[probe]) as ws:
        # Leave the glob pending so command dispatch owns boundary expansion.
        monkeypatch.setattr(argv_module, "resolve_globs", defer_once)
        result = await ws.execute(f"{head} {pattern} 'a b' ''")
        assert result.exit_code == 0
        tokens = (*prefix, *matches, "a b", "")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize("source", [False, True])
async def test_scripted_multiword_capture_sees_its_full_command(kind, source):
    script = (ScriptSource(
        "ctx['command'] == 'trello board list' and "
        "ctx['commands'][-1]['command'] == 'trello board list' and "
        "ctx['commands'][-1]['words'][-1] == '/allowed'")
              if source else lambda ctx: ctx.command == "trello board list" and
              ctx.commands[-1].command == "trello board list" and ctx.commands[
                  -1].words[-1] == "/allowed")
    probe = kind(captures=("trello board list", ), script=script)
    ram = RAMResource()
    ram.register(board_list)
    async with workspace({"/": ram},
                         runtimes=[probe, MontyRuntime(captures=())]) as ws:
        allowed = await ws.execute("echo ok | trello board list /allowed")
        assert allowed.exit_code == 0
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == ("trello", "board", "list",
                                              "/allowed")
            probe.requests.clear()
        else:
            assert shlex.split(
                probe.lines[0]) == ["trello", "board", "list", "/allowed"]
            probe.lines.clear()
        denied = await ws.execute("echo ok | trello board list /denied")
        assert denied.exit_code == 126
        assert not (probe.requests
                    if isinstance(probe, ProcessProbe) else probe.lines)


@pytest.mark.asyncio
@pytest.mark.parametrize("head", [
    "echo ok", "cat /input", "custom-stage", "trello board list", "custom-cli",
    "python3"
])
async def test_external_script_sees_first_unresolved_stage(head):
    seen = []
    probe = ProcessProbe(
        script=lambda ctx: seen.append(ctx) or ctx.command == "native-tool")
    named = ProcessProbe(captures=("python3", ))
    named.name = "named"
    ram = RAMResource()
    ram.register(board_list)
    async with workspace({"/": ram}, runtimes=[probe, named]) as ws:
        ws.register_cli(
            "custom-cli",
            CLISpec(name="custom-cli", fn=lambda inv: (b"ok\n", IOResult())))
        await ws.execute("echo ok > /input")
        await ws.execute("custom-stage() { echo ok; }")
        seen.clear()
        result = await ws.execute(head + " | native-tool")
        assert result.exit_code == 0
        assert len(probe.requests) == 1
        assert seen[0].command == "native-tool"
        assert not seen[0].builtin
        assert seen[0].line == head + " | native-tool"
        assert seen[0].commands[0].command == ("trello board list"
                                               if head == "trello board list"
                                               else head.split()[0])
        probe.requests.clear()
        denied = await ws.execute(head + " | denied-tool")
        assert denied.exit_code == 126
        assert not probe.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize("line", [
    "cat secret.txt",
    "cat ./secret.txt",
    "cat /work/secret.txt",
    "cat -- secret.txt",
    "cat s*.txt",
    "grep pattern secret.txt",
    "tar -cf archive.tar -C /work secret.txt",
])
async def test_named_external_capture_cannot_bypass_path_policy(kind, line):
    probe = kind(captures=("cat", "grep", "tar"))
    policy = RulePolicy(
        CommandRule(reason="protected",
                    commands=("cat", "grep", "tar"),
                    paths=("/work/secret.txt", )))
    async with workspace({"/work": RAMResource()},
                         runtimes=[probe],
                         policies=[policy],
                         mode=MountMode.EXEC) as ws:
        assert (await
                ws.execute("echo secret > /work/secret.txt")).exit_code == 0
        await ws.execute("cd /work")
        result = await ws.execute(line)
        assert result.exit_code != 0
        assert "protected" in await result.stderr_str()
        assert not (probe.requests
                    if isinstance(probe, ProcessProbe) else probe.lines)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_external_spec_preserves_text_words_and_shell_globs(kind):
    probe = kind(captures=("grep", ))
    policy = RulePolicy(
        CommandRule(reason="protected",
                    commands=("grep", ),
                    paths=("/work/secret.txt", )))
    async with workspace({"/work": RAMResource()},
                         runtimes=[probe],
                         policies=[policy],
                         mode=MountMode.EXEC) as ws:
        assert (await
                ws.execute("echo secret > /work/secret.txt")).exit_code == 0
        assert (await
                ws.execute("echo public > /work/public.txt")).exit_code == 0
        await ws.execute("cd /work")
        result = await ws.execute("grep secret.txt public*.txt")
        assert result.exit_code == 0
        tokens = ("grep", "secret.txt", "public.txt")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize("willing", [True, False])
async def test_native_captures_preserve_shell_builtins(kind, willing):
    probe = kind(captures=tuple(SHELL_NAMES), script=lambda ctx: willing)
    async with workspace({"/work": RAMResource()},
                         mode=MountMode.EXEC,
                         runtimes=[probe]) as ws:
        session = Session(session_id="lookup")
        for name in SHELL_NAMES - {"python", "python3", "node", "js"}:
            assert lookup(name, session,
                          ws._registry) is Consumer.SESSION, name
            layers = lookup_all(name, session, ws._registry)
            assert layers[0] is Consumer.SESSION, name
            assert Consumer.EXTERNAL not in layers, name
        assert (await ws.execute("cd /work")).exit_code == 0
        assert await (await ws.execute("pwd")).stdout_str() == "/work\n"
        assert (await ws.execute("export NATIVE_TEST=kept")).exit_code == 0
        assert await (await ws.execute('printf "%s\n" "$NATIVE_TEST"')
                      ).stdout_str() == "kept\n"
        assert await (await ws.execute("echo shell")).stdout_str() == "shell\n"
        assert await (await ws.execute("type -a echo")
                      ).stdout_str() == "echo is a shell builtin\n"
        assert not (probe.requests
                    if isinstance(probe, ProcessProbe) else probe.lines)
        for name in ("python", "python3", "node", "js"):
            result = await ws.execute(name + " --version")
            assert result.exit_code == (0 if willing else 126)
        delegated = probe.requests if isinstance(probe,
                                                 ProcessProbe) else probe.lines
        assert len(delegated) == (4 if willing else 0)
