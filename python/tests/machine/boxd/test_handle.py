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
import logging
import os
import signal
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from boxd.errors import APIConnectionError, ConflictError, NotFoundError

from mirage import RAMVFS, MountMode, Workspace
from mirage.commands.config import Context
from mirage.context.session_context import run_as_process
from mirage.execution.process.table import ProcessTable
from mirage.machine.boxd import BoxdMachine, sdk
from mirage.machine.constants import wrap_line
from mirage.machine.errors import ConnectionLostError
from mirage.machine.registry import build_machine
from mirage.types import PathSpec
from tests.fixtures.machine import machine_runtime, on

logger = logging.getLogger(__name__)


class LocalStream:
    """boxd's exec stream over a local ``/bin/sh``: stdin as written,
    stdout and stderr separately, byte for byte, and ``close`` ends the
    command's process group."""

    def __init__(
        self, command: str, close_stdin: bool, fail=None, fail_after=0
    ) -> None:
        self.command = command
        self.close_stdin = close_stdin
        self.fail = fail
        self.fail_after = fail_after
        self.exit_code = None
        self.closed = False
        self.proc = None
        self._lock = asyncio.Lock()
        # Like the SDK's, input queues without bound and never waits.
        self._input: asyncio.Queue = asyncio.Queue()
        self._sender = None

    async def _start(self):
        async with self._lock:
            if self.proc is None:
                self.proc = await asyncio.create_subprocess_exec(
                    "/bin/sh",
                    "-c",
                    self.command,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    start_new_session=True,
                )
                if self.close_stdin:
                    self.proc.stdin.close()
        return self.proc

    async def write(self, data: bytes) -> None:
        await self._start()
        self._input.put_nowait(data)
        self._send()

    async def write_eof(self) -> None:
        await self._start()
        self._input.put_nowait(None)
        self._send()

    def _send(self) -> None:
        if self._sender is None:
            self._sender = asyncio.create_task(self._sending())

    async def _sending(self) -> None:
        stdin = self.proc.stdin
        try:
            while (data := await self._input.get()) is not None:
                stdin.write(data)
                await stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            logger.debug("the fake command closed its input: %s", exc)
            return
        if not stdin.is_closing():
            stdin.close()

    async def iter_chunks(self) -> AsyncIterator[SimpleNamespace]:
        proc = await self._start()
        queue: asyncio.Queue = asyncio.Queue()

        async def pump(reader, is_stderr):
            while data := await reader.read(65536):
                await queue.put(
                    SimpleNamespace(data=data, is_stderr=is_stderr)
                )
            await queue.put(None)

        pumps = [
            asyncio.create_task(pump(proc.stdout, False)),
            asyncio.create_task(pump(proc.stderr, True)),
        ]
        try:
            ended = 0
            while ended < 2:
                chunk = await queue.get()
                if chunk is None:
                    ended += 1
                    continue
                if self.fail is not None:
                    if self.fail_after == 0:
                        raise self.fail
                    self.fail_after -= 1
                yield chunk
            self.exit_code = await proc.wait()
        finally:
            for task in pumps:
                task.cancel()
            if self._sender is not None:
                self._sender.cancel()
            if not proc.stdin.is_closing():
                proc.stdin.close()
            if proc.returncode is None:
                os.killpg(proc.pid, signal.SIGTERM)
            await proc.wait()

    async def close(self) -> None:
        self.closed = True
        if self.proc is not None and self.proc.returncode is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            await self.proc.wait()


class FakeMachines:
    def __init__(self, client) -> None:
        self.client = client

    async def get(self, machine_id):
        FakeClient.fetched.append(machine_id)
        if FakeClient.get_error is not None:
            raise FakeClient.get_error
        return SimpleNamespace(id=machine_id, status=FakeClient.status)

    def stream_exec(self, machine_id, *, command, close_stdin=False):
        stream = LocalStream(
            command,
            close_stdin,
            FakeClient.stream_error,
            FakeClient.stream_error_after,
        )
        FakeClient.streams.append((machine_id, command, close_stdin, stream))
        return stream


class FakeClient:
    configs: list = []
    fetched: list = []
    streams: list = []
    closed = 0
    status = "running"
    get_error = None
    stream_error = None
    stream_error_after = 0

    def __init__(self, api_key=None, region=None) -> None:
        FakeClient.configs.append({"api_key": api_key, "region": region})
        self.machines = FakeMachines(self)

    async def close(self):
        FakeClient.closed += 1


@pytest.fixture(autouse=True)
def fake_client(monkeypatch):
    FakeClient.configs = []
    FakeClient.fetched = []
    FakeClient.streams = []
    FakeClient.closed = 0
    FakeClient.status = "running"
    FakeClient.get_error = None
    FakeClient.stream_error = None
    FakeClient.stream_error_after = 0
    monkeypatch.setattr(sdk, "AsyncBoxd", FakeClient)


def _machine(**config) -> BoxdMachine:
    return BoxdMachine("box", config={"machine_id": "m-live", **config})


async def _endless() -> AsyncIterator[bytes]:
    while True:
        yield b"abcdef" * 1000


async def _idle() -> AsyncIterator[bytes]:
    yield b"one\ntwo\n"
    await asyncio.Event().wait()


async def _failing() -> AsyncIterator[bytes]:
    yield b"first\n"
    raise OSError("source went away")


class OpenInput:
    """An input that gives one chunk and then stays open until it is
    closed."""

    def __init__(self) -> None:
        self.closed = False
        self._sent = False
        self._released = asyncio.Event()

    def __aiter__(self) -> "OpenInput":
        return self

    async def __anext__(self) -> bytes:
        if self._sent:
            await self._released.wait()
            raise StopAsyncIteration
        self._sent = True
        return b"one\ntwo\n"

    async def aclose(self) -> None:
        self.closed = True
        self._released.set()


@pytest.mark.asyncio
async def test_connect_gets_the_users_machine_by_id():
    machine = _machine()
    await machine.connect()
    assert FakeClient.fetched == ["m-live"]
    assert machine.instance == "m-live"


def test_machine_id_is_required():
    with pytest.raises(TypeError, match="machine_id"):
        BoxdMachine("box", config={})


@pytest.mark.asyncio
async def test_api_key_and_region_reach_the_client():
    machine = _machine(api_key="k-123", region="nyc")
    await machine.connect()
    assert FakeClient.configs == [{"api_key": "k-123", "region": "nyc"}]


@pytest.mark.asyncio
async def test_unset_api_key_and_region_leave_them_to_the_sdk():
    await _machine().connect()
    assert FakeClient.configs == [{"api_key": None, "region": None}]


@pytest.mark.asyncio
async def test_missing_sdk_fails_with_install_hint(monkeypatch):
    monkeypatch.setattr(sdk, "AsyncBoxd", None)
    with pytest.raises(ImportError, match="mirage-ai\\[boxd\\]"):
        await _machine().connect()


@pytest.mark.asyncio
async def test_a_missing_machine_fails_with_what_to_do():
    FakeClient.get_error = NotFoundError("VM not found")
    with pytest.raises(RuntimeError, match="machine m-live is not running: "):
        await _machine().connect()


@pytest.mark.asyncio
async def test_a_stopped_machine_fails_with_what_to_do():
    FakeClient.status = "stopped"
    with pytest.raises(RuntimeError, match="boxd machine start"):
        await _machine().connect()


@pytest.mark.asyncio
async def test_a_destroyed_machine_fails_with_what_to_do():
    FakeClient.status = "destroyed"
    with pytest.raises(RuntimeError, match="deleted, never existed"):
        await _machine().connect()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["suspended", "hibernated"])
async def test_a_sleeping_machine_is_left_to_wake_on_the_line(status):
    FakeClient.status = status
    await _machine().connect()


@pytest.mark.asyncio
async def test_a_line_is_one_streamed_exec_of_the_wrapped_argv():
    machine = _machine()
    await machine.connect()
    result = await machine.exec_line("echo hi", None, {"E": "1"}, "/tmp")
    assert (result.exit_code, result.stdout, result.stderr) == (
        0,
        b"hi\n",
        b"",
    )
    [(machine_id, command, close_stdin, _)] = FakeClient.streams
    assert machine_id == "m-live"
    assert command == wrap_line(
        ("/bin/sh", "-c", "echo hi"), {"E": "1"}, "/tmp"
    )
    assert close_stdin is True


@pytest.mark.asyncio
@pytest.mark.parametrize("stdin", [None, b"in\xff\x00"])
async def test_arbitrary_bytes_and_the_exit_code_come_back_exactly(stdin):
    machine = _machine()
    await machine.connect()
    line = "printf 'a\\377\\000b\\r\\n'; printf 'e\\376\\000' >&2; " + (
        "exit 5" if stdin is None else "cat; exit 5"
    )
    result = await machine.exec_line(line, stdin, {}, "/")
    assert result.exit_code == 5
    assert result.stdout == b"a\xff\x00b\r\n" + (stdin or b"")
    assert result.stderr == b"e\xfe\x00"
    assert FakeClient.streams[0][2] is (stdin is None)


@pytest.mark.asyncio
async def test_a_program_that_stops_reading_ends_the_line():
    machine = _machine()
    await machine.connect()
    result = await machine.exec_line("head -c 3", b"abcdef" * 100000, {}, "/")
    assert (result.exit_code, result.stdout) == (0, b"abc")


@pytest.mark.asyncio
async def test_the_exit_ends_a_line_whose_input_never_ends():
    machine = _machine()
    await machine.connect()

    result = await asyncio.wait_for(
        machine.exec_line("head -c 3", _endless(), {}, "/"), 10
    )
    assert (result.exit_code, result.stdout) == (0, b"abc")


@pytest.mark.asyncio
async def test_the_exit_ends_a_line_whose_input_stays_open():
    machine = _machine()
    await machine.connect()

    result = await asyncio.wait_for(
        machine.exec_line("head -n 1", _idle(), {}, "/"), 10
    )
    assert (result.exit_code, result.stdout) == (0, b"one\n")


@pytest.mark.asyncio
async def test_an_input_that_fails_as_it_is_read_ends_the_line():
    machine = _machine()
    await machine.connect()

    with pytest.raises(OSError, match="source went away"):
        await asyncio.wait_for(
            machine.exec_line("cat; sleep 30", _failing(), {}, "/"), 10
        )
    stream = FakeClient.streams[0][3]
    assert stream.closed and stream.proc.returncode is not None


@pytest.mark.asyncio
async def test_a_finished_line_closes_an_input_that_stays_open():
    machine = _machine()
    await machine.connect()
    source = OpenInput()
    result = await asyncio.wait_for(
        machine.exec_line("head -n 1", source, {}, "/"), 10
    )
    assert (result.exit_code, result.stdout) == (0, b"one\n")
    assert source.closed


@pytest.mark.asyncio
async def test_a_cancelled_line_closes_an_input_that_stays_open():
    machine = _machine()
    await machine.connect()
    source = OpenInput()
    line = asyncio.create_task(
        machine.exec_line("cat; sleep 30", source, {}, "/")
    )
    while not FakeClient.streams or FakeClient.streams[0][3].proc is None:
        await asyncio.sleep(0.01)
    line.cancel()
    with pytest.raises(asyncio.CancelledError):
        await line
    assert source.closed


@pytest.mark.asyncio
async def test_output_streams_to_the_caller_as_it_arrives():
    machine = _machine()
    await machine.connect()
    out, err = bytearray(), bytearray()

    async def keep_out(data):
        out.extend(data)

    async def keep_err(data):
        err.extend(data)

    result = await machine._exec_argv(
        ("/bin/sh", "-c", "echo out; echo err >&2"),
        None,
        {},
        "/",
        keep_out,
        keep_err,
    )
    assert (result.stdout, result.stderr, bytes(out), bytes(err)) == (
        b"",
        b"",
        b"out\n",
        b"err\n",
    )


@pytest.mark.asyncio
async def test_a_cancelled_line_ends_its_stream():
    machine = _machine()
    await machine.connect()
    line = asyncio.create_task(machine.exec_line("sleep 30", None, {}, "/"))
    while not FakeClient.streams or FakeClient.streams[0][3].proc is None:
        await asyncio.sleep(0.01)
    line.cancel()
    with pytest.raises(asyncio.CancelledError):
        await line
    stream = FakeClient.streams[0][3]
    assert stream.closed and stream.proc.returncode is not None


# A kill with a gentler signal reaches the program before the stream ends,
# which would end it with TERM.
@pytest.mark.asyncio
async def test_a_kill_sends_its_signal_before_the_stream_ends(tmp_path):
    ready, seen = tmp_path / "ready", tmp_path / "seen"
    box = _machine()
    ctx = Context(
        flags={
            "c": f"trap 'echo INT >> {seen}; exit 0' INT; "
            f"trap 'echo TERM >> {seen}; exit 0' TERM; "
            f"echo up > {ready}; while :; do sleep 1; done"
        },
        env=None,
        cwd=PathSpec.from_str_path("/"),
    )

    async def run() -> int:
        return (
            await machine_runtime(box).run_line(None, [], [], ctx)
        ).exit_code

    runner = ProcessTable(bind=run_as_process).start(
        session_id="s", command="sh", cwd=ctx.cwd, run=run
    )
    async with asyncio.timeout(10):
        while not ready.exists():
            await asyncio.sleep(0.01)
        assert runner.terminate(signal.SIGINT)
        assert (await runner.join()).exit == 130
    assert seen.read_text() == "INT\n"


# What a line with no sinks read before the drop comes back with the error.
@pytest.mark.asyncio
async def test_a_dropped_connection_keeps_what_the_line_read():
    machine = _machine()
    await machine.connect()
    FakeClient.stream_error = APIConnectionError("connection reset")
    FakeClient.stream_error_after = 2
    with pytest.raises(ConnectionLostError) as lost:
        await machine.exec_line(
            "echo out; echo err >&2; sleep 0.3; echo more", None, {}, "/"
        )
    assert (lost.value.stdout, lost.value.stderr) == (
        b"out\n",
        b"err\nboxd: connection reset\n",
    )


@pytest.mark.asyncio
async def test_a_dropped_connection_loses_the_line_and_reconnects():
    FakeClient.stream_error = APIConnectionError("connection reset")
    box = _machine()
    ctx = Context(
        flags={"c": "echo hi"}, env=None, cwd=PathSpec.from_str_path("/")
    )
    result = await machine_runtime(box).run_line(None, [], [], ctx)
    assert result.exit_code == 129
    assert b"boxd: connection reset\n" in result.stderr
    assert b"mirage: boxd:box: connection lost\n" in result.stderr
    FakeClient.stream_error = None
    again = await machine_runtime(box).run_line(None, [], [], ctx)
    assert again.exit_code == 0
    assert FakeClient.fetched == ["m-live", "m-live"]


@pytest.mark.asyncio
async def test_a_refused_exec_loses_the_line_and_the_next_connects_again():
    box = _machine()
    ctx = Context(
        flags={"c": "echo hi"}, env=None, cwd=PathSpec.from_str_path("/")
    )
    FakeClient.stream_error = ConflictError("machine is not running")
    result = await machine_runtime(box).run_line(None, [], [], ctx)
    assert result.exit_code == 129
    assert b"boxd: machine is not running\n" in result.stderr
    FakeClient.stream_error = None
    FakeClient.status = "stopped"
    with pytest.raises(RuntimeError, match="boxd machine start"):
        await machine_runtime(box).run_line(None, [], [], ctx)
    assert FakeClient.fetched == ["m-live", "m-live"]


@pytest.mark.asyncio
async def test_a_machine_deleted_under_a_line_says_what_to_do():
    machine = _machine()
    await machine.connect()
    FakeClient.stream_error = NotFoundError("VM not found")
    with pytest.raises(ConnectionLostError, match="machine m-live is not"):
        await machine.exec_line("echo hi", None, {}, "/")


@pytest.mark.asyncio
async def test_close_releases_the_client_never_the_machine():
    machine = _machine()
    await machine.connect()
    await machine.close()
    # The fake exposes no delete or stop: close only drops the client.
    assert FakeClient.closed == 1


def test_registers_under_the_config_name_boxd():
    machine = build_machine("box", {"provider": "boxd", "machine_id": "m-1"})
    assert isinstance(machine, BoxdMachine)
    assert str(machine.machine) == "boxd:box"


def test_mount_type_is_refused():
    with pytest.raises(ValueError, match="boxd: mount_type needs a pipe"):
        _machine(mount_type="ssh")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "profile",
    [
        {"paths": {"hide": ["/data/secret"]}},
        {"commands": {"deny": [{"paths": ["/data/secret"], "reason": "x"}]}},
        {"mounts": {"/data": "r"}},
    ],
)
async def test_a_session_restriction_refuses_every_line(profile):
    runtime = _machine()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        profiles={"agent": profile},
        **on(runtime, "workspace"),
    )
    agent = await ws.session("agent", profile="agent")
    result = await agent.shell("tool run")
    assert (result.exit_code, result.stdout, result.stderr) == (
        126,
        b"",
        b"boxd: Permission denied\n",
    )
    assert FakeClient.fetched == []
    other = await (await ws.session("other")).shell("tool run")
    # The line reaches the machine, whose shell has no `tool`.
    assert other.exit_code == 127
    assert FakeClient.fetched == ["m-live"]
    await ws.close()
