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
import io
import shlex
from dataclasses import dataclass

import pytest
from e2b import CommandExitException, NotFoundException

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.io.types import materialize
from mirage.runtime.sandbox.constants import wrap_line
from mirage.runtime.sandbox.e2b import E2BConfig, E2BRuntime, sdk
from mirage.runtime.sandbox.e2b.constants import PTY_MARK, PTY_RAW
from mirage.runtime.types import RunResult, SandboxPipe
from mirage.types import PathSpec


def _line(box: E2BRuntime, line: str, stdin: bytes | None, env=None):
    cwd = PathSpec.from_str_path("/workspace")
    ctx = Context(flags={"c": line}, stdin=stdin, env=env, cwd=cwd)
    return box.run_line(None, [], [], ctx)


@dataclass
class FakeResult:
    stdout: str
    stderr: str
    exit_code: int


class FakeHandle:
    def __init__(self, command: str, stdin: bool):
        self.command = command
        self.input = bytearray()
        self.eof = not stdin
        self.disconnected = False
        self.killed = False
        self.waiting = asyncio.Event()
        self.input_error = None

    async def send_stdin(self, data):
        if self.input_error is not None:
            raise self.input_error
        self.input.extend(data)

    async def close_stdin(self):
        self.eof = True

    async def wait(self):
        self.waiting.set()
        if self.command == "sleep":
            await asyncio.Event().wait()
        if self.command == "exit 3":
            raise CommandExitException(
                stderr="boom-err", stdout="partial", exit_code=3, error=None
            )
        assert self.eof
        return FakeResult(self.input.hex(), "warn", 0)

    async def kill(self):
        self.killed = True

    async def disconnect(self):
        self.disconnected = True


class FakeCommands:
    def __init__(self):
        self.calls = []
        self.handles = []
        self.input_error = None

    async def run(self, command, *, background, stdin, on_stdout, timeout):
        assert (background, timeout) == (True, 0)
        self.calls.append((command, stdin))
        handle = FakeHandle(shlex.split(command)[-1], stdin)
        handle.input_error = self.input_error
        self.handles.append(handle)
        return handle


class FakePtyHandle:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.ended = asyncio.Event()

    async def wait(self):
        await self.ended.wait()
        raise CommandExitException(
            stderr="", stdout="", exit_code=-1, error="killed"
        )


class FakePty:
    """E2B's pty API: the shell echoes its line, then the command speaks."""

    def __init__(self):
        self.sent: list[bytes] = []
        self.handle = FakePtyHandle(7)
        self.on_data = None
        self.created = None
        self.refuse = False

    async def create(self, size, *, on_data, timeout):
        self.created = (size.rows, size.cols, timeout)
        self.on_data = on_data
        return self.handle

    async def send_stdin(self, pid, data):
        assert pid == self.handle.pid
        if self.refuse:
            raise RuntimeError("the sandbox went away")
        self.sent.append(data)
        if len(self.sent) == 1:
            self.on_data(b"$ stty raw -echo\r\n" + PTY_MARK[:3])
            self.on_data(PTY_MARK[3:] + b"\x00sftp")

    async def kill(self, pid):
        assert pid == self.handle.pid
        self.handle.ended.set()
        return True


class FakeSandbox:
    connected = []
    last = None

    def __init__(self):
        self.commands = FakeCommands()
        self.pty = FakePty()

    @classmethod
    async def connect(cls, sandbox_id, **params):
        cls.connected.append((sandbox_id, params))
        await asyncio.sleep(0)
        cls.last = cls()
        return cls.last


@pytest.fixture(autouse=True)
def fake_sdk(monkeypatch):
    FakeSandbox.connected = []
    FakeSandbox.last = None
    monkeypatch.setattr(sdk, "AsyncSandbox", FakeSandbox)


@pytest.mark.asyncio
async def test_connect_attaches_by_id_with_api_key():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live", "api_key": "k-123"})
    await runtime.connect()
    assert FakeSandbox.connected == [("sb-live", {"api_key": "k-123"})]


def test_sandbox_id_is_required():
    with pytest.raises(TypeError, match="sandbox_id"):
        E2BRuntime(config={})


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, b"", b"a\nb\n", bytes(range(256))])
async def test_native_stdin_eof_and_command_are_preserved(data):
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    result = await _line(runtime, "wc -l | cat", data, {"E": "1"})
    assert result.exit_code == 0
    assert result.stdout == (data or b"").hex().encode()
    assert result.stderr == b"warn"
    sandbox = FakeSandbox.last
    assert sandbox.commands.calls == [
        (
            wrap_line(
                ("/bin/sh", "-c", "wc -l | cat"), {"E": "1"}, "/workspace"
            ),
            data is not None,
        )
    ]
    handle = sandbox.commands.handles[0]
    assert handle.eof and handle.disconnected and not handle.killed


@pytest.mark.asyncio
@pytest.mark.parametrize("early_exit", [False, True])
async def test_nonzero_exit_preserves_output_even_when_stdin_loses_exit_race(
    early_exit,
):
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    if early_exit:
        FakeSandbox.last.commands.input_error = NotFoundException(
            "process exited"
        )
    result = await runtime.exec_line("exit 3", b"input", {}, "/workspace")
    assert (result.exit_code, result.stdout, result.stderr) == (
        3,
        b"partial",
        b"boom-err",
    )
    handle = FakeSandbox.last.commands.handles[0]
    assert handle.disconnected and not handle.killed


@pytest.mark.asyncio
async def test_parallel_calls_connect_once_and_keep_input_separate():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    payloads = [bytes([i]) * 100 for i in range(6)]
    results = await asyncio.gather(
        *(_line(runtime, "cat", data) for data in payloads)
    )
    assert len(FakeSandbox.connected) == 1
    assert [r.stdout for r in results] == [
        data.hex().encode() for data in payloads
    ]
    assert all(h.disconnected for h in FakeSandbox.last.commands.handles)


@pytest.mark.asyncio
async def test_input_transport_failure_kills_only_its_command_and_disconnects():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeSandbox.last.commands.input_error = RuntimeError(
        "stdin transport failed"
    )
    with pytest.raises(RuntimeError, match="stdin transport failed"):
        await runtime.exec_line("cat", b"input", {}, "/workspace")
    handle = FakeSandbox.last.commands.handles[0]
    assert handle.killed and handle.disconnected


@pytest.mark.asyncio
async def test_cancellation_kills_command_and_disconnects():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    task = asyncio.create_task(
        runtime.exec_line("sleep", None, {}, "/workspace")
    )
    await asyncio.sleep(0)
    handle = FakeSandbox.last.commands.handles[0]
    await handle.waiting.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert handle.killed and handle.disconnected


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncSandbox", None)
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    with pytest.raises(ImportError, match=r"mirage-ai\[e2b\]"):
        await runtime.connect()


@pytest.mark.parametrize("value", [None, "", " \t\n", 0, 1, False, [], {}])
def test_invalid_sandbox_id_is_rejected_before_connecting(value):
    with pytest.raises(ValueError, match="nonblank sandbox_id"):
        E2BConfig(sandbox_id=value)
    with pytest.raises(ValueError, match="nonblank sandbox_id"):
        E2BRuntime(config={"sandbox_id": value})
    assert FakeSandbox.connected == []


def test_mount_type_is_one_of_ssh_fuse_both():
    with pytest.raises(ValueError, match="e2b mount_type must be one of"):
        E2BRuntime(config={"sandbox_id": "sb", "mount_type": "nfs"})
    E2BRuntime(config={"sandbox_id": "sb", "mount_type": "both"})


@pytest.mark.asyncio
async def test_a_pipe_is_a_raw_pty_past_the_shells_own_output():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeSandbox.last.pty
    pipe = await runtime.open_pipe("exec sshfs x y")
    assert pty.created == (24, 80, 0)
    assert pty.sent == [f"{PTY_RAW}exec sshfs x y\n".encode()]
    assert await pipe.reader.readexactly(5) == b"\x00sftp"
    for part in (b"a", b"\x00", b"c"):
        pipe.writer.write(part)
    for _ in range(3):
        await asyncio.sleep(0)
    assert pty.sent[1:] == [b"a\x00c"]
    await pipe.stop()
    assert pty.handle.ended.is_set()
    assert pipe.reader.at_eof()


@pytest.mark.asyncio
async def test_a_reply_that_cannot_be_sent_ends_the_pipe_with_its_error():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeSandbox.last.pty
    pipe = await runtime.open_pipe("exec sshfs x y")
    assert await pipe.reader.readexactly(5) == b"\x00sftp"
    pty.refuse = True
    pipe.writer.write(b"reply")
    with pytest.raises(RuntimeError, match="the sandbox went away"):
        await asyncio.wait_for(pipe.reader.read(1), 1)
    assert pty.handle.ended.is_set()


@pytest.mark.asyncio
async def test_a_pty_whose_command_cannot_be_sent_is_killed():
    runtime = E2BRuntime(config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeSandbox.last.pty
    pty.refuse = True
    with pytest.raises(RuntimeError, match="the sandbox went away"):
        await runtime.open_pipe("exec sshfs x y")
    assert pty.handle.ended.is_set()


class MountingE2BRuntime(E2BRuntime):
    """A sandbox that answers its mount table, takes sshfs pipes and
    records the lines it runs."""

    def __init__(self, **options):
        super().__init__(**options)
        self.table: dict[str, str] = {}
        self.lines: list[str] = []

    async def _exec_argv(self, argv, stdin, env, cwd, output):
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(self, line, stdin, env, cwd):
        self.lines.append(line)
        rows = "".join(f"src {p} {t} rw 0 0\n" for p, t in self.table.items())
        stdout = rows if line == "cat /proc/mounts" else ""
        return RunResult(stdout=stdout.encode(), stderr=None, exit_code=0)

    async def open_pipe(self, command):
        self.table[shlex.split(command)[6]] = "fuse.sshfs"
        requests = asyncio.StreamReader()

        async def stop() -> None:
            requests.feed_eof()

        return SandboxPipe(requests, io.BytesIO(), stop)


RESTRICTIONS = [
    {"paths": {"hide": ["/data/secret"]}},
    {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "sealed"}]}},
    {"mounts": {"/data": "r"}},
]


def restricted(runtime, profile):
    return Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        runtimes=[runtime, "workspace"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_with_no_mount_type(
    profile,
):
    runtime = MountingE2BRuntime(config={"sandbox_id": "sb-live"})
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stderr) == (
        126,
        b"e2b: Permission denied\n",
    )
    assert FakeSandbox.connected == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_on_fuse_mounts(profile):
    runtime = MountingE2BRuntime(
        config={"sandbox_id": "sb-live", "mount_type": "fuse"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stderr) == (
        126,
        b"e2b: Permission denied\n",
    )
    assert "tool run" not in runtime.lines
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_ssh_mounts_serve_a_restricted_session_its_files(profile):
    runtime = MountingE2BRuntime(
        config={"sandbox_id": "sb-live", "mount_type": "ssh"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert result.exit_code == 0
    assert runtime.table == {"/data": "fuse.sshfs"}
    assert "tool run" in runtime.lines
    await ws.close()
