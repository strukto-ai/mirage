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
import json
import shlex
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
import yaml

from mirage import EXTERNAL_COMMANDS, RAMVFS, Limit, MountMode, Workspace
from mirage.commands.config import Context, command
from mirage.commands.spec.types import Argument, CommandSpec
from mirage.config import _build_runtime_entries
from mirage.io import IOResult
from mirage.io.types import materialize
from mirage.policy import AdmissionRules, CommandRule, Policy
from mirage.policy.builtin.output_cap import DEFAULT_COMMAND_LIMITS
from mirage.policy.builtin.permissions import PermissionsPolicy
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import Program, RunResult
from mirage.workspace.expand import argv as argv_module
from mirage.workspace.lookup import SHELL_NAMES, Consumer, lookup, lookup_all
from mirage.workspace.session import SessionState


async def _request(texts: list[str], ctx: Context) -> SimpleNamespace:
    return SimpleNamespace(
        argv=tuple(texts),
        cwd=ctx.cwd,
        env=ctx.env or {},
        stdin=await materialize(ctx.stdin) if ctx.stdin is not None else None,
    )


class ProcessProbe(Runtime, ProcessExecutorMixin):
    name = "probe"
    captures = (EXTERNAL_COMMANDS,)

    def __init__(self, **options):
        super().__init__(**options)
        self.requests: list[SimpleNamespace] = []

    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        request = await _request(texts, ctx)
        self.requests.append(request)
        return RunResult(
            stdout=request.stdin or b"GPU ready\nother\n",
            stderr=None,
            exit_code=0,
        )


class DelayedProcessProbe(ProcessProbe):
    cancelled = False

    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        self.requests.append(await _request(texts, ctx))
        try:
            await asyncio.sleep(0.15)
            return RunResult(stdout=b"completed\n", stderr=None, exit_code=0)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


class InProcessPython(PythonRuntime):
    name = "inproc"

    async def interpret(
        self, engine, program: Program, ctx, output=None, errors=None
    ) -> RunResult:
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class _OneRule:
    """Every session's compiled profile: one deny rule."""

    def __init__(self, rule: CommandRule) -> None:
        self.rules = AdmissionRules(deny=(rule,))

    def commands_of(self, session_id: str) -> AdmissionRules:
        return self.rules


def _profile_rule(rule: CommandRule) -> PermissionsPolicy:
    return PermissionsPolicy(_OneRule(rule))


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
    async with workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        result = await ws.shell(
            "printf 'GPU ready\nother\n' | native-tool | grep GPU > /out"
        )
        assert result.exit_code == 0
        assert await result.stdout_str() == ""
        assert await (await ws.shell("cat /out")).stdout_str() == "GPU ready\n"
        assert probe.requests[0].argv == ("native-tool",)
        assert probe.requests[0].stdin == b"GPU ready\nother\n"
        assert len(probe.requests) == 1


@pytest.mark.asyncio
async def test_native_argv_preserves_empty_words_and_interpreter_options():
    probe = ProcessProbe(captures=("python3", EXTERNAL_COMMANDS))
    async with workspace(
        {"/work": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        await ws.shell("cd /work")
        result = await ws.shell(
            "TOKEN=one python3 -c 'print(1)' -u 'a b' '$(echo literal)' ''"
        )
        assert result.exit_code == 0
        request = probe.requests[0]
        assert request.argv == (
            "python3",
            "-c",
            "print(1)",
            "-u",
            "a b",
            "$(echo literal)",
            "",
        )
        assert request.cwd.virtual == "/work"
        assert request.env["TOKEN"] == "one"
        await ws.shell("native-tool")
        assert "TOKEN" not in probe.requests[1].env


@pytest.mark.asyncio
async def test_a_native_runtime_chosen_for_the_line_gets_the_words_as_typed():
    probe = ProcessProbe(captures=("python3",))
    async with workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[InProcessPython(), probe],
    ) as ws:
        result = await ws.shell("python3 -c 'print(1)' arg", runtime="probe")
        assert result.exit_code == 0
        assert probe.requests[0].argv == ("python3", "-c", "print(1)", "arg")


@pytest.mark.asyncio
async def test_external_globs_expand_against_the_workspace():
    probe = ProcessProbe()
    async with workspace(
        {"/work": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        await ws.shell("touch /work/a.txt /work/b.txt")
        result = await ws.shell("native-tool /work/*.txt '/work/*.txt'")
        assert result.exit_code == 0
        assert probe.requests[0].argv == (
            "native-tool",
            "/work/a.txt",
            "/work/b.txt",
            "/work/*.txt",
        )


@pytest.mark.asyncio
async def test_external_fallback_globs_every_unquoted_word():
    # bash globs a word whatever it looks like: a leading dot matches the
    # dotfiles and `x=*` a file named `x=1`, and a quoted or unmatched
    # pattern stays the word as typed.
    probe = ProcessProbe()
    async with workspace(
        {"/work": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        await ws.shell("touch /work/.a.txt '/work/x=1'")
        await ws.shell("cd /work")
        result = await ws.shell("native-tool .*.txt x=* '.*.txt' .none*")
        assert result.exit_code == 0
        assert probe.requests[0].argv == (
            "native-tool",
            ".a.txt",
            "x=1",
            ".*.txt",
            ".none*",
        )


@pytest.mark.asyncio
async def test_shell_function_precedes_external_and_discovery_names_the_route():
    probe = ProcessProbe(captures=("named-tool", EXTERNAL_COMMANDS))
    async with workspace({"/": RAMVFS()}, runtimes=[probe]) as ws:
        assert (
            await (await ws.shell("type -t named-tool")).stdout_str()
            == "file\n"
        )
        await ws.shell("native-tool() { echo function; }")
        assert (
            await (await ws.shell("native-tool")).stdout_str() == "function\n"
        )
        assert not probe.requests


@pytest.mark.asyncio
async def test_a_name_only_the_fallback_takes_runs_but_is_not_found():
    probe = ProcessProbe()
    async with workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        for line in (
            "which native-tool",
            "command -v native-tool",
            "type -t native-tool",
            "cat /usr/bin/native-tool",
        ):
            result = await ws.shell(line)
            assert result.exit_code == 1, line
            assert await result.stdout_str() == "", line
        result = await ws.shell("type native-tool")
        assert (
            await result.stderr_str() == "bash: type: native-tool: not found\n"
        )
        assert (await ws.shell("native-tool")).exit_code == 0
        assert probe.requests[0].argv == ("native-tool",)


@pytest.mark.parametrize(
    "entry",
    ["- name: sandlock", '- name: sandlock\n  captures: ["@external"]'],
)
def test_yaml_external_capture_matches_the_sdk_default(entry):
    entries = _build_runtime_entries(yaml.safe_load(entry))
    assert entries[0].captures == (EXTERNAL_COMMANDS,)


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["native-tool", "python3"])
@pytest.mark.parametrize("timeout", [1, 0, None])
async def test_external_mount_timeout_replaces_default(
    monkeypatch, name, timeout
):
    monkeypatch.setitem(
        DEFAULT_COMMAND_LIMITS, name, Limit(timeout_seconds=0.05)
    )
    probe = DelayedProcessProbe(captures=("python3", EXTERNAL_COMMANDS))
    async with workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        for mount in ws._registry.mounts():
            mount.command_limits[name] = Limit(timeout_seconds=timeout)
        result = await ws.shell(f"PROGRAM={name}; $PROGRAM")
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
    overrides = (
        {"native-tool": Limit(timeout_seconds=0.05)}
        if source == "mount"
        else {}
    )
    probe = DelayedProcessProbe()
    async with workspace(
        {"/": (RAMVFS(), MountMode.EXEC, overrides)},
        mode=MountMode.EXEC,
        runtimes=[probe],
    ) as ws:
        result = await ws.shell("native-tool")
        assert result.exit_code == 124
        assert (
            "native-tool: timed out after 0.05s" in await result.stderr_str()
        )
        assert len(probe.requests) == 1
        assert probe.cancelled


@pytest.mark.asyncio
async def test_external_timeout_includes_stdin_materialization(monkeypatch):
    monkeypatch.setitem(
        DEFAULT_COMMAND_LIMITS, "native-tool", Limit(timeout_seconds=0.05)
    )
    cancelled = False

    async def slow_stdin():
        nonlocal cancelled
        try:
            await asyncio.sleep(0.15)
            yield b"late\n"
        finally:
            cancelled = True

    probe = ProcessProbe()
    async with workspace({"/": RAMVFS()}, runtimes=[probe]) as ws:
        result = await ws.shell("native-tool", stdin=slow_stdin())
        assert result.exit_code == 124
        assert (
            "native-tool: timed out after 0.05s" in await result.stderr_str()
        )
        assert not probe.requests
        assert cancelled


class ShellProbe(Runtime, LineExecutorMixin):
    name = "shell-probe"

    def __init__(self, **options):
        super().__init__(**options)
        self.lines: list[str] = []

    async def run_line(
        self, engine, paths, texts, ctx, output=None, errors=None
    ):
        self.lines.append(ctx.flags["c"])
        return RunResult(stdout=b"ok\n", stderr=None, exit_code=0)


@command(
    "trello board list",
    vfs="ram",
    spec=CommandSpec(
        arguments=(
            Argument("path", type="path", nargs="?", metavar=""),
            Argument("texts", nargs="*", metavar=""),
        )
    ),
)
async def board_list(accessor, paths, texts, opts):
    return b"ok\n", IOResult()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize(
    "head, expected",
    [
        ("trello board list", ("trello", "board", "list")),
        ("'trello board list'", ("trello board list",)),
    ],
)
async def test_native_execution_preserves_command_tokens(kind, head, expected):
    probe = kind(captures=("trello board list",))
    async with workspace({"/": RAMVFS()}, runtimes=[probe]) as ws:
        ws.mount("/").register_commands([board_list])
        result = await ws.shell(head + " 'a b' '$(echo literal)' ''")
        assert result.exit_code == 0
        tokens = (*expected, "a b", "$(echo literal)", "")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize(
    "head, prefix",
    [
        ("trello board list", ("trello", "board", "list")),
        ("'trello board list'", ("trello board list",)),
    ],
)
@pytest.mark.parametrize(
    "pattern, matches",
    [
        ("/base/i*", ("/base/inner",)),
        ("/base/*", ("/base/inner", "/base/other")),
    ],
)
async def test_boundary_expansion_preserves_command_tokens(
    kind, head, prefix, pattern, matches, monkeypatch
):
    probe = kind(captures=("trello board list",))
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
            "/": RAMVFS(),
            "/base/inner": RAMVFS(),
            "/base/other": RAMVFS(),
        },
        mode=MountMode.EXEC,
        runtimes=[probe],
    ) as ws:
        ws.mount("/").register_commands([board_list])
        # Leave the glob pending so command dispatch owns boundary expansion.
        monkeypatch.setattr(argv_module, "resolve_globs", defer_once)
        result = await ws.shell(f"{head} {pattern} 'a b' ''")
        assert result.exit_code == 0
        tokens = (*prefix, *matches, "a b", "")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize(
    "line",
    [
        "cat secret.txt",
        "cat ./secret.txt",
        "cat /work/secret.txt",
        "cat -- secret.txt",
        "cat s*.txt",
        "grep pattern secret.txt",
        "tar -cf archive.tar -C /work secret.txt",
    ],
)
async def test_named_external_capture_cannot_bypass_path_policy(kind, line):
    probe = kind(captures=("cat", "grep", "tar"))
    policy = _profile_rule(
        CommandRule(
            reason="protected",
            commands=("cat", "grep", "tar"),
            paths=("/work/secret.txt",),
        )
    )
    async with workspace(
        {"/work": RAMVFS()},
        runtimes=[probe],
        policies=[policy],
        mode=MountMode.EXEC,
    ) as ws:
        assert (
            await ws.shell("echo secret > /work/secret.txt")
        ).exit_code == 0
        await ws.shell("cd /work")
        result = await ws.shell(line)
        assert result.exit_code != 0
        assert result.refusal and result.refusal.reason == "protected"
        assert not (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_external_spec_preserves_text_words_and_shell_globs(kind):
    probe = kind(captures=("grep",))
    policy = _profile_rule(
        CommandRule(
            reason="protected", commands=("grep",), paths=("/work/secret.txt",)
        )
    )
    async with workspace(
        {"/work": RAMVFS()},
        runtimes=[probe],
        policies=[policy],
        mode=MountMode.EXEC,
    ) as ws:
        assert (
            await ws.shell("echo secret > /work/secret.txt")
        ).exit_code == 0
        assert (
            await ws.shell("echo public > /work/public.txt")
        ).exit_code == 0
        await ws.shell("cd /work")
        result = await ws.shell("grep secret.txt public*.txt")
        assert result.exit_code == 0
        tokens = ("grep", "secret.txt", "public.txt")
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize(
    "line, tokens",
    [
        ("python3 s.py *.txt", ("python3", "s.py", "a.txt", "b.txt")),
        (
            "python3 -c p /work/*.txt",
            ("python3", "-c", "p", "/work/a.txt", "/work/b.txt"),
        ),
        (
            "python3 s.py ../work/?.txt",
            ("python3", "s.py", "../work/a.txt", "../work/b.txt"),
        ),
        (
            "python3 s.py '*.txt' \\*.txt",
            ("python3", "s.py", "*.txt", "*.txt"),
        ),
        ("python3 s.py *.none", ("python3", "s.py", "*.none")),
        ("python3 s.py .*.txt", ("python3", "s.py", ".a.txt")),
        ("python3 s.py x=*", ("python3", "s.py", "x=1")),
        ("python3 s.py .none*", ("python3", "s.py", ".none*")),
        ("shopt -s nullglob; python3 s.py *.none x", ("python3", "s.py", "x")),
        ("set -f; python3 s.py *.txt", ("python3", "s.py", "*.txt")),
    ],
)
async def test_external_text_slot_globs_expand_like_bash(kind, line, tokens):
    probe = kind(captures=("python3",))
    async with workspace(
        {"/work": RAMVFS()}, runtimes=[probe], mode=MountMode.EXEC
    ) as ws:
        await ws.shell(
            "touch /work/a.txt /work/b.txt /work/.a.txt '/work/x=1'"
        )
        await ws.shell("cd /work")
        result = await ws.shell(line)
        assert result.exit_code == 0
        if isinstance(probe, ProcessProbe):
            assert probe.requests[0].argv == tokens
        else:
            assert shlex.split(probe.lines[0]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_external_text_slot_glob_obeys_failglob(kind):
    probe = kind(captures=("python3",))
    async with workspace(
        {"/work": RAMVFS()}, runtimes=[probe], mode=MountMode.EXEC
    ) as ws:
        await ws.shell("cd /work")
        await ws.shell("shopt -s failglob")
        result = await ws.shell("python3 s.py *.none")
        assert result.exit_code == 1
        assert await result.stderr_str() == "bash: no match: *.none\n"
        assert not (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_external_admission_reads_the_expanded_argv(kind):
    probe = kind(captures=("grep", "python3"))
    policy = _profile_rule(
        CommandRule(
            reason="protected",
            commands=("grep", "python3"),
            paths=("/work/secret.txt",),
        )
    )
    async with workspace(
        {"/work": RAMVFS()},
        runtimes=[probe],
        policies=[policy],
        mode=MountMode.EXEC,
    ) as ws:
        assert (
            await ws.shell("echo secret > /work/secret.txt")
        ).exit_code == 0
        assert (
            await ws.shell("echo public > /work/public.txt")
        ).exit_code == 0
        await ws.shell("cd /work")
        # One word fills grep's pattern and its file operand, so the
        # match that lands in the file slot is a path the gate reads.
        refused = await ws.shell("grep *.txt")
        assert refused.exit_code != 0
        assert refused.refusal and "protected" in refused.refusal.reason
        assert not (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )
        # A match in a text slot is text, as the word typed by hand is.
        for line, tokens in (
            ("grep s*.txt public.txt", ("grep", "secret.txt", "public.txt")),
            ("python3 s.py s*.txt", ("python3", "s.py", "secret.txt")),
        ):
            result = await ws.shell(line)
            assert result.exit_code == 0, line
            if isinstance(probe, ProcessProbe):
                assert probe.requests[-1].argv == tokens
            else:
                assert shlex.split(probe.lines[-1]) == list(tokens)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
@pytest.mark.parametrize(
    "line",
    [
        "python3 /work/steal.py",
        "python3 steal.py",
        "python3 ./steal.py",
        "python3 -u steal.py",
        "python3 -W ignore -- steal.py",
        "node steal.js",
        "node -- /work/steal.js",
        "python ./-",
        "python3 -- /work/-",
        "js ./-",
        "node -- /work/-",
    ],
)
async def test_interpreter_script_cannot_bypass_path_policy(kind, line):
    # The script is a file the runtime reads on its own machine, outside
    # the dispatcher, so the gate has to see it as the path it is
    # (`python3 steal.py` reads /work/steal.py exactly as `cat steal.py`
    # does), whatever option run precedes it.
    probe = kind(captures=("python", "python3", "js", "node"))
    policy = _profile_rule(CommandRule(reason="protected", paths=("/work/*",)))
    async with workspace(
        {"/work": RAMVFS()},
        runtimes=[probe],
        policies=[policy],
        mode=MountMode.EXEC,
    ) as ws:
        await ws.shell("cd /work")
        result = await ws.shell(line)
        name, operand = line.split()[0], line.split()[-1]
        assert result.exit_code == 1
        assert (
            await result.stderr_str()
            == f"{name}: {operand}: Permission denied\n"
        )
        assert result.refusal and result.refusal.reason == "protected"
        assert not (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_interpreter_program_operands_are_not_paths(kind):
    # Once -c, -m or -e names the program, every operand is that
    # program's argv, as are the words after a script; none is a file
    # the rule reads, and each reaches the runtime as typed.
    probe = kind(captures=("python", "python3", "js", "node"))
    policy = _profile_rule(CommandRule(reason="protected", paths=("/work/*",)))
    lines = [
        ("python - /work/arg", ("python", "-", "/work/arg")),
        ("python3 -u -- - -c x", ("python3", "-u", "--", "-", "-c", "x")),
        ("js -- - /work/arg", ("js", "--", "-", "/work/arg")),
        ("node - -e x", ("node", "-", "-e", "x")),
        (
            "python3 -c 'print(1)' steal.py",
            ("python3", "-c", "print(1)", "steal.py"),
        ),
        (
            "python3 -m json.tool steal.py",
            ("python3", "-m", "json.tool", "steal.py"),
        ),
        ("node -e 1 steal.js", ("node", "-e", "1", "steal.js")),
        ("python3 /open.py steal.py", ("python3", "/open.py", "steal.py")),
    ]
    async with workspace(
        {"/work": RAMVFS()},
        runtimes=[probe],
        policies=[policy],
        mode=MountMode.EXEC,
    ) as ws:
        await ws.shell("cd /work")
        for line, _ in lines:
            assert (await ws.shell(line)).exit_code == 0, line
        delegated = (
            [r.argv for r in probe.requests]
            if isinstance(probe, ProcessProbe)
            else [tuple(shlex.split(run)) for run in probe.lines]
        )
        assert delegated == [tokens for _, tokens in lines]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", [ProcessProbe, ShellProbe])
async def test_native_captures_preserve_shell_builtins(kind):
    probe = kind(captures=tuple(SHELL_NAMES))
    async with workspace(
        {"/work": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        session = SessionState(session_id="lookup")
        for name in SHELL_NAMES - {
            "python",
            "python3",
            "node",
            "js",
            "ps",
            "kill",
        }:
            assert lookup(name, session, ws._registry) is Consumer.SESSION, (
                name
            )
            layers = lookup_all(name, session, ws._registry)
            assert layers[0] is Consumer.SESSION, name
            assert Consumer.EXTERNAL not in layers, name
        assert (await ws.shell("cd /work")).exit_code == 0
        assert await (await ws.shell("pwd")).stdout_str() == "/work\n"
        assert (await ws.shell("export NATIVE_TEST=kept")).exit_code == 0
        assert (
            await (await ws.shell('printf "%s\n" "$NATIVE_TEST"')).stdout_str()
            == "kept\n"
        )
        assert await (await ws.shell("echo shell")).stdout_str() == "shell\n"
        assert await (await ws.shell("type -a echo")).stdout_str() == (
            "echo is a shell builtin\necho is /usr/bin/echo\n"
        )
        assert not (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )
        for name in ("python", "python3", "node", "js"):
            result = await ws.shell(name + " --version")
            assert result.exit_code == 0
        delegated = (
            probe.requests if isinstance(probe, ProcessProbe) else probe.lines
        )
        assert len(delegated) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name,args", [("ps", "-eo pid,cmd"), ("kill", "-0 456")]
)
async def test_explicit_process_command_captures_reach_the_runtime(name, args):
    probe = ProcessProbe(captures=(name,))
    async with workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[probe]
    ) as ws:
        result = await ws.shell(f"{name} {args}")
        assert result.exit_code == 0
        assert [r.argv for r in probe.requests] == [
            tuple([name] + args.split())
        ]


class FailingProcess(ProcessProbe):
    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        raise RuntimeError("provider unavailable")


@pytest.mark.asyncio
async def test_a_provider_error_belongs_to_its_command_and_the_line_continues():
    async with workspace({}, runtimes=[FailingProcess(), "workspace"]) as ws:
        result = await ws.shell("echo before; failed-tool; echo after")
        assert result.exit_code == 0
        assert result.stdout == b"before\nafter\n"
        assert result.stderr == b"failed-tool: provider unavailable\n"


class ErringProbe(ProcessProbe):
    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        if errors is None:
            return RunResult(stdout=b"", stderr=b"whole\n", exit_code=0)
        await errors(b"streamed\n")
        return RunResult(stdout=b"", stderr=None, exit_code=0)


class SeesResults(Policy):
    def __init__(self) -> None:
        self.results: list[str] = []

    async def post_execute(self, ctx):
        self.results.append(json.dumps(ctx.results))
        return None


# A program's stderr streams into the line as it arrives and still lands in
# the command's record, which post_execute policies read.
@pytest.mark.asyncio
async def test_streamed_stderr_stays_in_the_command_record():
    seen = SeesResults()
    async with workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[ErringProbe()],
        policies=[seen],
    ) as ws:
        result = await ws.shell("native-tool")
        assert await result.stderr_str() == "streamed\n"
    assert '"stderr": "streamed\\n"' in seen.results[0]


class EndlessProbe(ProcessProbe):
    async def run_process(
        self, engine, paths, texts, ctx, output, errors=None
    ) -> RunResult:
        while True:
            await output(b"y\n")


# A reader that stops early stops the program, as SIGPIPE stops it.
@pytest.mark.asyncio
async def test_a_program_its_reader_stopped_exits_141():
    async with workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[EndlessProbe()]
    ) as ws:
        result = await ws.shell(
            'endless-tool | head -n 1; echo "${PIPESTATUS[@]}"'
        )
        assert await result.stdout_str() == "y\n141 0\n"


# An output cap stops the program the same way, and the command's record,
# which post_execute policies read, keeps the status it settled with.
@pytest.mark.asyncio
async def test_a_program_its_cap_stopped_is_recorded_as_141(monkeypatch):
    monkeypatch.setitem(
        DEFAULT_COMMAND_LIMITS, "endless-tool", Limit(max_lines=1)
    )
    seen = SeesResults()
    async with workspace(
        {"/": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[EndlessProbe()],
        policies=[seen],
    ) as ws:
        result = await ws.shell("endless-tool")
        assert await result.stdout_str() == "y\n"
        assert result.exit_code == 141
    assert '"exit_code": 141' in seen.results[0]
