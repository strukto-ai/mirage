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
import base64
import codecs
import io
import shlex
from dataclasses import dataclass
from types import SimpleNamespace

import pytest
from e2b import CommandExitException, NotFoundException, SandboxException

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.process.table import ProcessTable
from mirage.io.types import materialize
from mirage.machine.constants import (
    MOUNT_GUARD,
    PROCESS,
    encode_output,
    is_run,
    run_argv,
    run_status_path,
    stop_line,
    wrap_line,
)
from mirage.machine.e2b import E2BConfig, E2BMachine, sdk
from mirage.machine.e2b.constants import PTY_MARK, PTY_RAW
from mirage.machine.types import MachinePipe
from mirage.runtime.types import RunResult
from mirage.types import PathSpec
from tests.fixtures.machine import machine_runtime, on


def _line(box: E2BMachine, line: str, stdin: bytes | None, env=None):
    cwd = PathSpec.from_str_path("/workspace")
    ctx = Context(flags={"c": line}, stdin=stdin, env=env, cwd=cwd)
    return machine_runtime(box).run_line(None, [], [], ctx)


def b64(text: str) -> str:
    """``text`` as the machine's encoder sends it."""
    return base64.b64encode(text.encode()).decode() + "\n"


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
        self.received = asyncio.Event()
        self.closed = asyncio.Event()
        self.input_error = None
        self.on_stdout = None
        self.on_stderr = None

    async def send_stdin(self, data):
        if self.input_error is not None:
            raise self.input_error
        self.input.extend(data)
        self.received.set()

    async def close_stdin(self):
        self.eof = True
        self.closed.set()

    async def wait(self):
        self.waiting.set()
        if self.command == "sleep":
            await asyncio.Event().wait()
        if self.command == "exit 0":
            return FakeResult(b64("partial"), b64("boom-err"), 0)
        if self.command == "exit 3":
            raise CommandExitException(
                stderr=b64("boom-err"),
                stdout=b64("partial"),
                exit_code=3,
                error=None,
            )
        if self.command == "head":
            await self.received.wait()
            return FakeResult(b64(self.input.hex()), "", 0)
        if not self.eof:
            await self.closed.wait()
        if self.on_stdout is not None:
            await self.on_stdout(b64(self.input.hex()))
        if self.on_stderr is not None:
            await self.on_stderr(b64("warn"))
        return FakeResult(b64(self.input.hex()), b64("warn"), 0)

    async def kill(self):
        self.killed = True

    async def disconnect(self):
        self.disconnected = True


class FakeCommands:
    def __init__(self):
        self.calls = []
        self.handles = []
        self.input_error = None

    async def run(
        self, command, *, background, stdin, on_stdout, on_stderr, timeout
    ):
        assert (background, timeout) == (True, 0)
        self.calls.append((command, stdin))
        handle = FakeHandle(shlex.split(command)[-1], stdin)
        handle.input_error = self.input_error
        handle.on_stdout = on_stdout
        handle.on_stderr = on_stderr
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
            raise RuntimeError("the machine went away")
        self.sent.append(data)
        if len(self.sent) == 1:
            self.on_data(b"$ stty raw -echo\r\n" + PTY_MARK[:3])
            self.on_data(PTY_MARK[3:] + b"\x00sftp")

    async def kill(self, pid):
        assert pid == self.handle.pid
        self.handle.ended.set()
        return True


class FakeMachine:
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
    FakeMachine.connected = []
    FakeMachine.last = None
    monkeypatch.setattr(sdk, "AsyncSandbox", FakeMachine)


@pytest.mark.asyncio
async def test_connect_attaches_by_id_with_api_key():
    runtime = E2BMachine(
        "box", config={"sandbox_id": "sb-live", "api_key": "k-123"}
    )
    await runtime.connect()
    assert FakeMachine.connected == [("sb-live", {"api_key": "k-123"})]


def test_sandbox_id_is_required():
    with pytest.raises(TypeError, match="sandbox_id"):
        E2BMachine("box", config={})


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, b"", b"a\nb\n", bytes(range(256))])
async def test_native_stdin_eof_and_command_are_preserved(data, monkeypatch):
    monkeypatch.setattr(
        "mirage.machine.handle.uuid.uuid4",
        lambda: SimpleNamespace(hex="run"),
    )
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    result = await _line(runtime, "wc -l | cat", data, {"E": "1"})
    assert result.exit_code == 0
    assert result.stdout == (data or b"").hex().encode()
    assert result.stderr == b"warn"
    sandbox = FakeMachine.last
    assert sandbox.commands.calls == [
        (
            encode_output(
                wrap_line(
                    run_argv(
                        "run",
                        run_status_path("run"),
                        (),
                        ("/bin/sh", "-c", "wc -l | cat"),
                    ),
                    {"E": "1"},
                    "/workspace",
                )
            ),
            data is not None,
        )
    ]
    handle = sandbox.commands.handles[0]
    assert handle.eof and handle.disconnected and not handle.killed


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "input_error",
    [
        None,
        NotFoundException("process exited"),
        SandboxException(
            "Code.INTERNAL: error writing to stdin of process '2815': "
            "write |1: broken pipe"
        ),
        SandboxException(
            "Code.INTERNAL: error writing to stdin: error writing to stdin "
            "of process '2822': write |1: file already closed"
        ),
    ],
)
@pytest.mark.parametrize("exit_code", [0, 3])
async def test_exit_preserves_output_even_when_stdin_loses_exit_race(
    input_error,
    exit_code,
):
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeMachine.last.commands.input_error = input_error
    result = await runtime.exec_line(
        f"exit {exit_code}", b"input", {}, "/workspace"
    )
    assert (result.exit_code, result.stdout, result.stderr) == (
        exit_code,
        b"partial",
        b"boom-err",
    )
    handle = FakeMachine.last.commands.handles[0]
    assert handle.disconnected and not handle.killed


@pytest.mark.asyncio
async def test_a_command_that_exits_ends_the_line_while_its_input_stays_open():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()

    async def open_input():
        yield b"one\n"
        await asyncio.Event().wait()

    result = await asyncio.wait_for(
        runtime.exec_line("head", open_input(), {}, "/workspace"), 5
    )
    assert (result.exit_code, result.stdout) == (0, b"one\n".hex().encode())
    handle = FakeMachine.last.commands.handles[0]
    assert handle.disconnected and not handle.killed


@pytest.mark.asyncio
async def test_parallel_calls_connect_once_and_keep_input_separate():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    payloads = [bytes([i]) * 100 for i in range(6)]
    results = await asyncio.gather(
        *(_line(runtime, "cat", data) for data in payloads)
    )
    assert len(FakeMachine.connected) == 1
    assert [r.stdout for r in results] == [
        data.hex().encode() for data in payloads
    ]
    assert all(h.disconnected for h in FakeMachine.last.commands.handles)


# An untagged run (the stop's own line) that fails is killed and starts
# nothing more.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "input_error",
    [
        RuntimeError("stdin transport failed"),
        SandboxException("Code.INTERNAL: stdin transport failed"),
    ],
)
async def test_input_transport_failure_kills_only_its_command_and_disconnects(
    input_error,
):
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeMachine.last.commands.input_error = input_error
    with pytest.raises(type(input_error), match="stdin transport failed"):
        await runtime._exec_argv(
            ("/bin/sh", "-c", "cat"), b"input", {}, "/workspace", None, None
        )
    handle = FakeMachine.last.commands.handles[0]
    assert handle.killed and handle.disconnected
    assert len(FakeMachine.last.commands.calls) == 1


# A kill reaches only the shell that encodes the output, so a tagged run
# that fails for a reason other than a cancel is also stopped by its tag.
@pytest.mark.asyncio
async def test_a_tagged_run_that_fails_is_stopped_by_its_tag():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime._ensure_connected()
    commands = FakeMachine.last.commands
    commands.input_error = RuntimeError("stdin transport failed")
    with pytest.raises(RuntimeError, match="stdin transport failed"):
        await runtime.exec_line("cat", b"input", {PROCESS: "run"}, "/")
    assert [shlex.split(command)[-1] for command, _ in commands.calls] == [
        "cat",
        stop_line("run", 15),
    ]


# A streamed command's stderr goes to its errors callback as it arrives,
# and the result carries none of it twice.
@pytest.mark.asyncio
async def test_streamed_stderr_goes_to_the_errors_callback():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    said: list[bytes] = []

    async def errors(chunk: bytes) -> None:
        said.append(chunk)

    result = await runtime._exec_argv(
        ("/bin/sh", "-c", "cat"), b"in", {}, "/workspace", None, errors
    )
    assert (said, result.stderr) == ([b"warn"], b"")


# A kill reaches only the encoding shell, so a line run with no tag of its
# caller's gets its own and a cancelled one is stopped by it.
@pytest.mark.asyncio
async def test_a_cancelled_line_is_killed_and_stopped_by_its_own_tag(
    monkeypatch,
):
    monkeypatch.setattr(
        "mirage.machine.e2b.handle.uuid.uuid4",
        lambda: SimpleNamespace(hex="line"),
    )
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime._ensure_connected()
    commands = FakeMachine.last.commands
    task = asyncio.create_task(
        runtime.exec_line("sleep", None, {}, "/workspace")
    )
    await asyncio.sleep(0)
    handle = commands.handles[0]
    await handle.waiting.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert handle.killed and handle.disconnected
    assert [shlex.split(command)[-1] for command, _ in commands.calls] == [
        "sleep",
        stop_line("line", 15),
    ]


async def _hang(_handle: FakeHandle) -> None:
    await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_a_stop_that_times_out_starts_no_other_stop(monkeypatch):
    monkeypatch.setattr(FakeHandle, "wait", _hang)
    monkeypatch.setattr(
        "mirage.machine.handle.MACHINE_STOP_WAIT_SECONDS", 0.01
    )
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime._ensure_connected()
    async with asyncio.timeout(2):
        assert await runtime.stop("t", 15) is False
    assert [
        shlex.split(command)[-1]
        for command, _ in FakeMachine.last.commands.calls
    ] == [stop_line("t", 15)]


# A kill that names a gentler signal leaves a run's tagged command to the
# stop, which sends it that signal first; an untagged one (mount setup, a
# direct exec) has no stop behind it and is killed. Either way the runtime
# runs nothing more: a cancelled run is the caller's to stop.
@pytest.mark.asyncio
@pytest.mark.parametrize("env,killed", [({PROCESS: "run"}, False), ({}, True)])
async def test_a_term_kill_leaves_only_a_tagged_command_to_the_stop(
    env, killed
):
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()

    async def run() -> int:
        result = await runtime._exec_argv(
            ("/bin/sh", "-c", "sleep"), None, env, "/workspace", None, None
        )
        return result.exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    await asyncio.sleep(0)
    handle = FakeMachine.last.commands.handles[0]
    await handle.waiting.wait()
    assert runner.terminate(15)
    await runner.join()
    assert (handle.killed, handle.disconnected) == (killed, True)
    assert len(FakeMachine.last.commands.calls) == 1


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncSandbox", None)
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    with pytest.raises(ImportError, match=r"mirage-ai\[e2b\]"):
        await runtime.connect()


@pytest.mark.parametrize("value", [None, "", " \t\n", 0, 1, False, [], {}])
def test_invalid_sandbox_id_is_rejected_before_connecting(value):
    with pytest.raises(ValueError, match="nonblank sandbox_id"):
        E2BConfig(sandbox_id=value)
    with pytest.raises(ValueError, match="nonblank sandbox_id"):
        E2BMachine("box", config={"sandbox_id": value})
    assert FakeMachine.connected == []


def test_mount_type_is_one_of_ssh_fuse_both():
    with pytest.raises(ValueError, match="e2b mount_type must be one of"):
        E2BMachine("box", config={"sandbox_id": "sb", "mount_type": "nfs"})
    E2BMachine("box", config={"sandbox_id": "sb", "mount_type": "both"})


@pytest.mark.asyncio
async def test_a_pipe_is_a_raw_pty_past_the_shells_own_output():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeMachine.last.pty
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
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeMachine.last.pty
    pipe = await runtime.open_pipe("exec sshfs x y")
    assert await pipe.reader.readexactly(5) == b"\x00sftp"
    pty.refuse = True
    pipe.writer.write(b"reply")
    with pytest.raises(RuntimeError, match="the machine went away"):
        await asyncio.wait_for(pipe.reader.read(1), 1)
    assert pty.handle.ended.is_set()


@pytest.mark.asyncio
async def test_a_pty_whose_command_cannot_be_sent_is_killed():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    pty = FakeMachine.last.pty
    pty.refuse = True
    with pytest.raises(RuntimeError, match="the machine went away"):
        await runtime.open_pipe("exec sshfs x y")
    assert pty.handle.ended.is_set()


class MountingE2BMachine(E2BMachine):
    """A sandbox that answers its mount table, takes sshfs pipes and
    records the lines it runs."""

    def __init__(self, captures=None, name="box", **options):
        super().__init__(name, **options)
        self.captures = captures
        self.table: dict[str, tuple[str, str]] = {}
        self.lines: list[str] = []

    async def _exec_argv(self, argv, stdin, env, cwd, output, errors):
        if is_run(argv):
            argv = argv[7:]
        if argv[2:3] == (MOUNT_GUARD,):
            argv = argv[argv.index("--", 5) + 1 :]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        return await self.exec_line(line, data, env, cwd)

    async def exec_line(self, line, stdin, env, cwd):
        self.lines.append(line)
        rows = "".join(
            f"{source} {p} {t} rw 0 0\n"
            for p, (source, t) in self.table.items()
        )
        stdout = rows if line == "cat /proc/mounts" else ""
        return RunResult(stdout=stdout.encode(), stderr=None, exit_code=0)

    async def open_pipe(self, command):
        source, prefix = shlex.split(command)[5:7]
        self.table[prefix] = (source, "fuse.sshfs")
        requests = asyncio.StreamReader()

        async def stop() -> None:
            requests.feed_eof()

        return MachinePipe(requests, io.BytesIO(), stop)


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
        **on(runtime, "workspace"),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_with_no_mount_type(
    profile,
):
    runtime = MountingE2BMachine(config={"sandbox_id": "sb-live"})
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stderr) == (
        126,
        b"e2b: Permission denied\n",
    )
    assert FakeMachine.connected == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("profile", RESTRICTIONS)
async def test_a_session_restriction_refuses_a_line_on_fuse_mounts(profile):
    runtime = MountingE2BMachine(
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
    runtime = MountingE2BMachine(
        config={"sandbox_id": "sb-live", "mount_type": "ssh"}
    )
    ws = restricted(runtime, profile)
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert result.exit_code == 0
    assert [kind for _, kind in runtime.table.values()] == ["fuse.sshfs"]
    assert list(runtime.table) == ["/data"]
    assert "tool run" in runtime.lines
    await ws.close()


class ShellHandle:
    """E2B's command handle over a local sh, its output decoded as the
    SDK decodes it (UTF-8, errors replaced) and read in small slices."""

    def __init__(self, process, on_stdout, on_stderr):
        self.process = process
        self.chunks = {"out": [], "err": []}
        self.pumps = asyncio.gather(
            self._pump(process.stdout, on_stdout, self.chunks["out"]),
            self._pump(process.stderr, on_stderr, self.chunks["err"]),
        )

    async def _pump(self, stream, callback, chunks):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            data = await stream.read(7)
            text = decoder.decode(data, final=not data)
            if text:
                chunks.append(text)
                if callback is not None:
                    await callback(text)
            if not data:
                return

    async def send_stdin(self, data):
        self.process.stdin.write(data)
        await self.process.stdin.drain()

    async def close_stdin(self):
        self.process.stdin.close()

    async def wait(self):
        await self.pumps
        code = await self.process.wait()
        stdout = "".join(self.chunks["out"])
        stderr = "".join(self.chunks["err"])
        if code:
            raise CommandExitException(
                stdout=stdout, stderr=stderr, exit_code=code, error=None
            )
        return FakeResult(stdout, stderr, code)

    async def kill(self):
        self.process.kill()

    async def disconnect(self):
        pass


class ShellCommands:
    async def run(
        self, command, *, background, stdin, on_stdout, on_stderr, timeout
    ):
        process = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            command,
            stdin=asyncio.subprocess.PIPE
            if stdin
            else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return ShellHandle(process, on_stdout, on_stderr)


BYTES_LINE = (
    "printf 'a\\377\\000b\\r\\n\\303'; printf 'e\\376\\000\\r\\n' >&2; exit 5"
)


# Program output is bytes: invalid UTF-8, NUL and CRLF reach the host
# unchanged on stdout and stderr, whole or streamed, with the program's
# status.
@pytest.mark.asyncio
@pytest.mark.parametrize("streamed", [False, True])
async def test_arbitrary_output_bytes_and_the_exit_code_come_back_exactly(
    streamed,
):
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeMachine.last.commands = ShellCommands()
    said = {"out": bytearray(), "err": bytearray()}

    async def output(chunk: bytes) -> None:
        said["out"] += chunk

    async def errors(chunk: bytes) -> None:
        said["err"] += chunk

    result = await runtime._exec_argv(
        ("/bin/sh", "-c", BYTES_LINE),
        None,
        {},
        "/",
        output if streamed else None,
        errors if streamed else None,
    )
    if streamed:
        stdout, stderr = bytes(said["out"]), bytes(said["err"])
        assert (result.stdout, result.stderr) == (b"", b"")
    else:
        stdout, stderr = result.stdout, result.stderr
    assert (result.exit_code, stdout, stderr) == (
        5,
        b"a\xff\x00b\r\n\xc3",
        b"e\xfe\x00\r\n",
    )


# A program's output reaches the host while it still runs: here it waits
# for input that is only sent once its first line has arrived.
@pytest.mark.asyncio
async def test_output_streams_while_the_program_runs():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeMachine.last.commands = ShellCommands()
    said = bytearray()
    first = asyncio.Event()

    async def output(chunk: bytes) -> None:
        said.extend(chunk)
        if b"one\n" in said:
            first.set()

    async def reply():
        await first.wait()
        yield b"two\n"

    result = await asyncio.wait_for(
        runtime._exec_argv(
            ("/bin/sh", "-c", "echo one; head -n 1"),
            reply(),
            {},
            "/",
            output,
            None,
        ),
        10,
    )
    assert (result.exit_code, bytes(said)) == (0, b"one\ntwo\n")


class TailCommands:
    """A command that streams a line, then a tail with no newline, on
    stdout and on stderr."""

    async def run(
        self, command, *, background, stdin, on_stdout, on_stderr, timeout
    ):
        handle = FakeHandle(command, stdin)
        await on_stdout(b64("a")[:3])
        await on_stdout(b64("a")[3:] + "mirage: tail")
        await on_stderr(b64("b")[:3])
        await on_stderr(b64("b")[3:] + "mirage: etail")
        return handle


# Streamed text decodes a whole line at a time; what is left when the
# stream ends without a newline still comes out, once.
@pytest.mark.asyncio
async def test_a_streamed_tail_without_a_newline_still_comes_out():
    runtime = E2BMachine("box", config={"sandbox_id": "sb-live"})
    await runtime.connect()
    FakeMachine.last.commands = TailCommands()
    said: dict[str, list[bytes]] = {"out": [], "err": []}

    async def output(chunk: bytes) -> None:
        said["out"].append(chunk)

    async def errors(chunk: bytes) -> None:
        said["err"].append(chunk)

    result = await runtime._exec_argv(
        ("/bin/sh", "-c", "x"), None, {}, "/", output, errors
    )
    assert (result.exit_code, said) == (
        0,
        {"out": [b"a", b"mirage: tail\n"], "err": [b"b", b"mirage: etail\n"]},
    )
