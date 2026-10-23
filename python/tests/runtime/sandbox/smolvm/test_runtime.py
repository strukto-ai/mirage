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

import json
from types import SimpleNamespace

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.sandbox.constants import EXEC_ID, EXEC_PRELUDE
from mirage.runtime.sandbox.smolvm import SmolvmRuntime
from mirage.types import PathSpec


class FakeSmolvmRuntime(SmolvmRuntime):
    def __init__(
        self,
        state: str = "running",
        status_code: int = 0,
        status_stdout: bytes | None = None,
        **options,
    ):
        super().__init__(**options)
        self.state = state
        self.status_code = status_code
        self.status_stdout = status_stdout
        self.calls: list[tuple[list[str], bytes | None]] = []

    async def _smolvm(self, args, stdin=None, output=None, errors=None):
        stdin = await materialize(stdin) if stdin is not None else None
        self.calls.append((list(args), stdin))
        if args[1] == "status":
            if self.status_stdout is not None:
                return self.status_stdout, b"", self.status_code
            if self.status_code != 0:
                return b"", b"machine 'vm' not found", self.status_code
            return (
                json.dumps({"name": "vm", "state": self.state}).encode(),
                b"",
                0,
            )
        script = args[-1]
        if output is not None:
            await output(f"out:{script}".encode())
            return b"", b"warn", 0
        return f"out:{script}".encode(), b"warn", 0


@pytest.mark.asyncio
async def test_connect_probes_the_users_machine_state():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    await runtime.connect()
    args, _ = runtime.calls[0]
    assert args == ["machine", "status", "--name", "vm", "--json"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("fake", "refusal"),
    [
        ({"state": "stopped"}, "not running"),
        ({"state": "unreachable"}, "guest agent is not answering"),
        ({"state": "frozen"}, "frozen fork base"),
        ({"state": "created"}, "never been started"),
        ({"state": "quiesced"}, r"state: quiesced"),
        ({"status_code": 1}, "machine 'vm' not found"),
        ({"status_stdout": b"not json"}, "unreadable json"),
    ],
)
async def test_connect_names_why_the_machine_cannot_take_a_line(fake, refusal):
    runtime = FakeSmolvmRuntime(**fake, config={"machine": "vm"})
    with pytest.raises(RuntimeError, match=refusal):
        await runtime.connect()


def test_machine_is_required():
    with pytest.raises(TypeError, match="machine"):
        SmolvmRuntime(config={})


@pytest.mark.asyncio
async def test_exec_line_threads_cwd_env_stdin_and_real_stderr():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    result = await runtime.exec_line(
        "wc -l", b"a\nb\n", {"E": "1"}, "/root/workspace"
    )
    assert result.exit_code == 0
    assert result.stdout == b"out:wc -l"
    assert result.stderr == b"warn"
    args, stdin = runtime.calls[-1]
    assert args == [
        "machine",
        "exec",
        "--name",
        "vm",
        "-i",
        "-w",
        "/",
        "-e",
        "E=1",
        "--",
        "/bin/sh",
        "-c",
        EXEC_PRELUDE,
        "sh",
        "/root/workspace",
        "/bin/sh",
        "-c",
        "wc -l",
    ]
    assert stdin == b"a\nb\n"


@pytest.mark.asyncio
async def test_exec_line_ends_flags_so_a_dashed_line_is_not_parsed():
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    await runtime.exec_line("--version", None, {}, "/")
    args, _ = runtime.calls[-1]
    assert args[args.index("--") + 1 :] == [
        "/bin/sh",
        "-c",
        EXEC_PRELUDE,
        "sh",
        "/",
        "/bin/sh",
        "-c",
        "--version",
    ]


@pytest.mark.asyncio
async def test_process_preserves_argv_and_shares_the_shell_connection(
    monkeypatch,
):
    monkeypatch.setattr(
        "mirage.runtime.sandbox.base.uuid.uuid4",
        lambda: SimpleNamespace(hex="run"),
    )
    runtime = FakeSmolvmRuntime(
        config={"machine": "vm", "env": {"E": "config"}}
    )
    argv = ("node", "a b", "$(echo literal)", "", "--flag")
    work = PathSpec.from_str_path("/work")
    ctx = Context(cwd=work, env={"E": "request"}, stdin=b"input")
    result = await runtime.execute([], list(argv), ctx, kind="process")
    assert result.stdout == b"out:--flag"
    assert result.stderr == b"warn"
    assert runtime.calls[-1] == (
        [
            "machine",
            "exec",
            "--name",
            "vm",
            "-i",
            "-w",
            "/",
            "-e",
            "E=request",
            "-e",
            f"{EXEC_ID}=run",
            "--",
            "/bin/sh",
            "-c",
            EXEC_PRELUDE,
            "sh",
            "/work",
            *argv,
        ],
        b"input",
    )
    line = Context(flags={"c": "pwd"}, cwd=work)
    await runtime.execute([], [], line, kind="line")
    assert sum(args[1] == "status" for args, _ in runtime.calls) == 1
    assert isinstance(runtime, ProcessExecutorMixin)
    assert isinstance(runtime, LineExecutorMixin)
    assert runtime.filesystem == ()


@pytest.mark.asyncio
async def test_process_refuses_a_stopped_vm_and_empty_argv():
    runtime = FakeSmolvmRuntime(state="stopped", config={"machine": "vm"})
    with pytest.raises(ValueError, match="argv must not be empty"):
        await runtime.execute([], [], Context(), kind="process")
    assert not runtime.calls
    with pytest.raises(RuntimeError, match="not running"):
        await runtime.execute([], ["node"], Context(), kind="process")
    assert len(runtime.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile",
    [
        {"paths": {"hide": ["/data/secret"]}},
        {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "x"}]}},
        {"mounts": {"/data": "r"}},
    ],
)
async def test_a_session_restriction_refuses_a_line_with_no_mount_type(
    profile,
):
    runtime = FakeSmolvmRuntime(config={"machine": "vm"})
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stdout, result.stderr) == (
        126,
        b"",
        b"smolvm: Permission denied\n",
    )
    assert runtime.calls == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()
