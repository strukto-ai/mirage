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

from mirage.runtime.sandbox.ssh import SSHRuntime, sdk


class FakeSSHRuntime(SSHRuntime):
    def __init__(self, **options):
        super().__init__(**options)
        self.calls: list[tuple[str, bytes | None]] = []

    async def _ssh(self, command, stdin):
        self.calls.append((command, stdin))
        return f"out:{command}".encode(), b"warn", 0


class FakeConn:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True

    async def wait_closed(self) -> None:
        return None


def test_host_is_required():
    with pytest.raises(TypeError, match="host"):
        SSHRuntime(config={})


def test_connect_kwargs_map_the_config():
    runtime = SSHRuntime(
        config={
            "host": "box",
            "hostname": "10.0.0.5",
            "port": 2222,
            "username": "deploy",
            "identity_file": "~/.ssh/id_ed25519",
            "timeout": 5,
        }
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


def test_connect_kwargs_defaults_stay_out():
    kwargs = SSHRuntime(config={"host": "box"})._connect_kwargs()
    assert kwargs == {"host": "box", "known_hosts": None, "login_timeout": 30}


@pytest.mark.asyncio
async def test_connect_requires_asyncssh(monkeypatch):
    monkeypatch.setattr(sdk, "connect", None)
    runtime = SSHRuntime(config={"host": "box"})
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
    runtime = SSHRuntime(config={"host": "box"})
    await runtime.connect()
    assert seen["host"] == "box"
    assert runtime._conn is conn


@pytest.mark.asyncio
async def test_exec_line_dresses_the_line_and_threads_stdin():
    runtime = FakeSSHRuntime(config={"host": "box"})
    result = await runtime.exec_line("wc -l", b"a\nb\n", {"E": "1"}, "/w")
    assert result.exit_code == 0
    assert result.stdout == b"out:cd '/w' && env 'E=1' sh -c 'wc -l'"
    assert result.stderr == b"warn"
    assert runtime.calls[0][1] == b"a\nb\n"


@pytest.mark.asyncio
async def test_close_ends_the_connection():
    runtime = SSHRuntime(config={"host": "box"})
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
        runtime = SSHRuntime(
            config={
                "host": "127.0.0.1",
                "port": server.get_port(),
                "username": "test",
            }
        )
        try:
            result = await asyncio.wait_for(
                runtime.run_line("cat", data, {}, "/"), 5
            )
            assert result.stdout == (data or b"").hex().encode()
            assert result.exit_code == 0
        finally:
            await runtime.close()


class HungProcess:
    """A remote command that runs until something kills it."""

    def __init__(self) -> None:
        self.stdin = self
        self.calls: list[str] = []
        self.done = asyncio.Event()

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
    runtime = SSHRuntime(config={"host": "box"})
    runtime._conn = HungConn(process)
    task = asyncio.create_task(runtime._ssh("sleep 30", None))
    while "eof" not in process.calls:
        await asyncio.sleep(0)
    task.cancel()
    async with asyncio.timeout(2):
        with pytest.raises(asyncio.CancelledError):
            await task
    assert process.calls == ["eof", "kill", "close"]


class LostProcess(HungProcess):
    """A remote command whose connection drops mid-wait."""

    async def wait(self, check: bool = False) -> None:
        raise ConnectionResetError("connection lost")


@pytest.mark.asyncio
async def test_a_failed_line_still_closes_its_channel():
    process = LostProcess()
    runtime = SSHRuntime(config={"host": "box"})
    runtime._conn = HungConn(process)
    with pytest.raises(ConnectionResetError):
        await runtime._ssh("true", None)
    assert process.calls == ["eof", "close"]
