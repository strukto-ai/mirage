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
from pathlib import Path

import asyncssh
import pytest

from mirage import MountMode, Workspace
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.process.table import ProcessTable
from mirage.io.types import materialize
from mirage.machine.constants import wrap_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.ssh import SSHMachine, sdk
from mirage.runtime.types import RunResult
from mirage.types import PathSpec
from mirage.vfs.ssh import SSHVFS, SSHConfig
from tests.fixtures.machine import machine_runtime, on


def _line(box: SSHMachine, line: str, stdin: bytes | None = None):
    return machine_runtime(box).run_line(
        None, [], [], Context(flags={"c": line}, stdin=stdin)
    )


class FakeSSHMachine(SSHMachine):
    def __init__(self, captures=None, name="box", **options):
        super().__init__(name, **options)
        self.captures = captures
        self.calls: list[tuple[str, bytes | None]] = []

    async def _ssh(
        self, command, stdin, output=None, errors=None, tagged=False
    ):
        data = await materialize(stdin) if stdin is not None else None
        self.calls.append((command, data))
        if output is not None:
            await output(f"out:{command}".encode())
            return RunResult(b"", b"warn", 0)
        return RunResult(f"out:{command}".encode(), b"warn", 0)


class FakeConn:
    def __init__(self) -> None:
        self.closed = False

    def is_closed(self) -> bool:
        return self.closed

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


def test_host_is_required():
    with pytest.raises(TypeError, match="host"):
        SSHMachine("box", config={})


def test_connect_kwargs_map_the_config():
    runtime = SSHMachine(
        "box",
        config={
            "host": "box",
            "hostname": "10.0.0.5",
            "port": 2222,
            "username": "deploy",
            "identity_file": "~/.ssh/id_ed25519",
            "timeout": 5,
        },
    )
    kwargs = runtime._connect_kwargs()
    assert kwargs["host"] == "10.0.0.5"
    assert kwargs["port"] == 2222
    assert kwargs["username"] == "deploy"
    assert kwargs["client_keys"] == [
        str(Path("~/.ssh/id_ed25519").expanduser())
    ]
    assert kwargs["known_hosts"] is None
    assert kwargs["login_timeout"] == 5


def test_a_private_key_is_offered_as_its_own_text_after_the_file():
    runtime = SSHMachine(
        "box",
        config={
            "host": "box",
            "identity_file": "~/.ssh/id_ed25519",
            "private_key": "key-text",
        },
    )
    assert runtime._connect_kwargs()["client_keys"] == [
        str(Path("~/.ssh/id_ed25519").expanduser()),
        b"key-text",
    ]
    only = SSHMachine("box", config={"host": "box", "private_key": "key-text"})
    assert only._connect_kwargs()["client_keys"] == [b"key-text"]


def test_connect_kwargs_defaults_stay_out():
    kwargs = SSHMachine("box", config={"host": "box"})._connect_kwargs()
    assert kwargs == {
        "host": "box",
        "known_hosts": None,
        "login_timeout": 30,
        "connect_timeout": 30,
    }


@pytest.mark.asyncio
async def test_connect_requires_asyncssh(monkeypatch):
    monkeypatch.setattr(sdk, "connect", None)
    runtime = SSHMachine("box", config={"host": "box"})
    with pytest.raises(ImportError, match=r"mirage-ai\[ssh\]"):
        await runtime.connect()


@pytest.mark.asyncio
async def test_connect_opens_one_reused_connection(monkeypatch):
    seen: dict = {}
    conn = FakeConn()

    async def fake_connect(**kwargs):
        seen.update(kwargs)
        return conn

    monkeypatch.setattr(sdk, "connect", fake_connect)
    runtime = SSHMachine("box", config={"host": "box"})
    await runtime.connect()
    assert seen["host"] == "box"
    assert runtime._conn is conn


@pytest.mark.asyncio
async def test_exec_line_dresses_the_line_and_threads_stdin():
    runtime = FakeSSHMachine(config={"host": "box"})
    result = await runtime.exec_line("wc -l", b"a\nb\n", {"E": "1"}, "/w")
    assert result.exit_code == 0
    wrapped = wrap_line(("/bin/sh", "-c", "wc -l"), {"E": "1"}, "/w")
    assert result.stdout == f"out:{wrapped}".encode()
    assert result.stderr == b"warn"
    assert runtime.calls[0][1] == b"a\nb\n"


@pytest.mark.asyncio
async def test_close_ends_the_connection():
    runtime = SSHMachine("box", config={"host": "box"})
    conn = FakeConn()
    runtime._conn = conn
    await runtime.close()
    assert conn.closed
    assert runtime._conn is None


class NoAuthServer(asyncssh.SSHServer):
    def begin_auth(self, username):
        return False


async def echo_input(process):
    data = await process.stdin.read()
    process.stdout.write(data.hex().encode())
    process.exit(0)


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, b"", bytes(range(256))])
async def test_real_ssh_stdin_always_reaches_eof(data):
    key = asyncssh.generate_private_key("ssh-ed25519")
    async with asyncssh.listen(
        "127.0.0.1",
        0,
        server_factory=NoAuthServer,
        server_host_keys=[key],
        process_factory=echo_input,
        encoding=None,
    ) as server:
        runtime = SSHMachine(
            "box",
            config={
                "host": "127.0.0.1",
                "port": server.get_port(),
                "username": "test",
            },
        )
        try:
            result = await asyncio.wait_for(_line(runtime, "cat", data), 5)
            assert result.stdout == (data or b"").hex().encode()
            assert result.exit_code == 0
        finally:
            await runtime.close()


@pytest.mark.asyncio
async def test_real_ssh_logs_in_with_a_private_key_given_as_its_text(
    monkeypatch, tmp_path
):
    # Only the generated key gets in: no agent, password or default key.
    monkeypatch.delenv("SSH_AUTH_SOCK", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    client_key = asyncssh.generate_private_key("ssh-ed25519")
    authorized = asyncssh.import_authorized_keys(
        client_key.export_public_key().decode()
    )
    async with asyncssh.listen(
        "127.0.0.1",
        0,
        server_host_keys=[host_key],
        authorized_client_keys=authorized,
        process_factory=echo_input,
        encoding=None,
    ) as server:
        config = {
            "host": "127.0.0.1",
            "port": server.get_port(),
            "username": "test",
        }
        keyed = SSHMachine(
            "box",
            config={
                **config,
                "private_key": client_key.export_private_key().decode(),
            },
        )
        try:
            result = await asyncio.wait_for(_line(keyed, "cat", b"in"), 5)
            assert result.stdout == b"in".hex().encode()
            assert result.exit_code == 0
        finally:
            await keyed.close()
        keyless = SSHMachine("box", config=config)
        try:
            with pytest.raises(asyncssh.PermissionDenied):
                await asyncio.wait_for(keyless.connect(), 5)
        finally:
            await keyless.close()


class HungOutput:
    """A remote stream that ends only once its command does."""

    def __init__(self, done: asyncio.Event) -> None:
        self.done = done

    async def read(self, n: int = -1) -> bytes:
        await self.done.wait()
        return b""


class HungProcess:
    """A remote command that runs until something kills it."""

    def __init__(self) -> None:
        self.stdin = self
        self.calls: list[str] = []
        self.done = asyncio.Event()
        self.stdout = self.stderr = HungOutput(self.done)

    async def drain(self) -> None:
        return None

    def write(self, data: bytes) -> None:
        self.calls.append("write")

    def write_eof(self) -> None:
        self.calls.append("eof")

    async def wait(self, check: bool = False) -> None:
        await self.done.wait()

    def kill(self) -> None:
        self.calls.append("kill")

    def close(self) -> None:
        self.calls.append("close")

    async def wait_closed(self) -> None:
        await self.done.wait()

    async def __aenter__(self) -> "HungProcess":
        return self

    async def __aexit__(self, *exc) -> None:
        self.close()
        await self.wait_closed()

    def __await__(self):
        yield from asyncio.sleep(0).__await__()
        return self


class HungConn:
    def __init__(self, process: HungProcess) -> None:
        self.process = process

    def create_process(self, command: str, encoding: str | None = None):
        return self.process


@pytest.mark.asyncio
async def test_a_cancelled_line_does_not_wait_for_the_remote_command():
    process = HungProcess()
    runtime = SSHMachine("box", config={"host": "box"})
    runtime._conn = HungConn(process)
    task = asyncio.create_task(runtime._ssh("sleep 30", None))
    while "eof" not in process.calls:
        await asyncio.sleep(0)
    task.cancel()
    async with asyncio.timeout(2):
        with pytest.raises(asyncio.CancelledError):
            await task
    assert process.calls == ["eof", "kill", "close"]


# A kill that names a gentler signal leaves a run's tagged command to the
# stop, which sends it that signal first; an untagged one (mount setup, a
# direct exec) has no stop behind it and is killed.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tagged,calls",
    [(True, ["eof", "close"]), (False, ["eof", "kill", "close"])],
)
async def test_a_term_kill_leaves_only_a_tagged_command_to_the_stop(
    tagged, calls
):
    process = HungProcess()
    runtime = SSHMachine("box", config={"host": "box"})
    runtime._conn = HungConn(process)

    async def run() -> int:
        code = (await runtime._ssh("sleep 30", None, tagged=tagged)).exit_code
        return code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s",
        command="sleep",
        cwd=PathSpec.from_str_path("/"),
        run=run,
    )
    while "eof" not in process.calls:
        await asyncio.sleep(0)
    assert runner.terminate(15)
    async with asyncio.timeout(2):
        await runner.join()
    assert process.calls == calls


class LostProcess(HungProcess):
    """A remote command whose connection drops mid-wait."""

    def __init__(self) -> None:
        super().__init__()
        self.done.set()

    async def wait(self, check: bool = False) -> None:
        raise ConnectionResetError("connection lost")


class PartialOutput:
    """A remote stream that gave this much before its connection went."""

    def __init__(self, data: bytes, error: Exception | None) -> None:
        self.data = data
        self.error = error

    async def read(self, n: int = -1) -> bytes:
        data, self.data = self.data, b""
        if data:
            return data
        if self.error is not None:
            raise self.error
        return b""


class EndedProcess(HungProcess):
    """A remote command whose channel ended with this exit status, or
    whose output and wait raised this error, after some output."""

    def __init__(
        self, returncode: int | None, error: Exception | None = None
    ) -> None:
        super().__init__()
        self.done.set()
        self.returncode = returncode
        self.error = error
        self.stdout = PartialOutput(b"before\n", error)

    async def wait(self, check: bool = False) -> "EndedProcess":
        if self.error is not None:
            raise self.error
        return self


# A channel that closed with no exit status, or a connection asyncssh saw
# drop, lost the remote command's end, keeping what it read; a reported
# exit keeps its status.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error", [None, asyncssh.ConnectionLost("Connection lost")]
)
async def test_a_dropped_channel_is_a_lost_connection(error):
    runtime = SSHMachine("box", config={"host": "box"})
    runtime._conn = HungConn(EndedProcess(None, error))
    with pytest.raises(ConnectionLostError, match="closed") as lost:
        await runtime._ssh("true", None)
    assert lost.value.stdout == b"before\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("returncode,code", [(0, 0), (3, 3), (-15, 143)])
async def test_a_reported_exit_keeps_its_status(returncode, code):
    runtime = SSHMachine("box", config={"host": "box"})
    runtime._conn = HungConn(EndedProcess(returncode))
    assert (await runtime._ssh("true", None)).exit_code == code


@pytest.mark.asyncio
async def test_a_failed_line_still_closes_its_channel():
    process = LostProcess()
    runtime = SSHMachine("box", config={"host": "box"})
    runtime._conn = HungConn(process)
    with pytest.raises(ConnectionResetError):
        await runtime._ssh("true", None)
    assert process.calls == ["eof", "close"]


@pytest.mark.asyncio
async def test_dropped_connection_reconnects_before_next_command(monkeypatch):
    connections: list[FakeConn] = []

    async def connect(**kwargs):
        conn = FakeConn()
        connections.append(conn)
        return conn

    monkeypatch.setattr(sdk, "connect", connect)
    runtime = FakeSSHMachine(config={"host": "box"})
    await _line(runtime, "true")
    await _line(runtime, "true")
    assert len(connections) == 1
    connections[0].close()
    await _line(runtime, "true")
    assert len(connections) == 2
    await runtime.close()


async def _fake_connect(**kwargs):
    return FakeConn()


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
    monkeypatch, profile
):
    monkeypatch.setattr(sdk, "connect", _fake_connect)
    runtime = FakeSSHMachine(config={"host": "box"})
    ws = Workspace(
        {"/data": SSHVFS(SSHConfig(host="box"))},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        **on(runtime, "workspace"),
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stdout, result.stderr) == (
        126,
        b"",
        b"ssh: Permission denied\n",
    )
    assert runtime.calls == []
    assert (await (await ws.session("other")).shell("tool run")).exit_code == 0
    await ws.close()
