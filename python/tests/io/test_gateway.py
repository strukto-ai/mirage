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
import socket
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from mirage import Workspace
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import CommandSpec
from mirage.io import network
from mirage.io.types import IOResult
from mirage.policy import (
    Deny,
    NetworkContext,
    NetworkResultContext,
    Policy,
)
from mirage.types import FileStat, Limit, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS


async def _answer(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    await reader.read(1024)
    writer.write(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n"
        b"Connection: close\r\n\r\nok\n"
    )
    await writer.drain()
    writer.close()


@pytest_asyncio.fixture
async def port():
    server = await asyncio.start_server(_answer, "127.0.0.1", 0)
    yield server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()


class _Watch(Policy):
    """Refuses the addresses it is given, counts what is open, keeps
    what each method saw."""

    def __init__(
        self, refused: tuple[str, ...] = (), limit: Limit | None = None
    ) -> None:
        self.refused = refused
        self.limit = limit
        self.open = 0
        self.asked: list[NetworkContext] = []
        self.ended: list[NetworkResultContext] = []

    async def pre_network(self, ctx: NetworkContext) -> Deny | Limit | None:
        self.asked.append(ctx)
        if ctx.address in self.refused:
            return Deny(f"{ctx.address} is not for this tenant")
        self.open += 1
        return self.limit

    async def post_network(self, ctx: NetworkResultContext) -> None:
        self.ended.append(ctx)
        self.open -= 1


async def _held(port: int, line: str, *policies: Policy, network=True) -> int:
    ws = Workspace({"/data": (RAMVFS(), MountMode.WRITE)}, network=network)
    for policy in policies:
        ws.policies.add(policy)
    try:
        return (await ws.shell(line.format(port=port))).exit_code
    finally:
        await ws.close()


_ANSWER = (
    b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n"
)


@pytest.mark.asyncio
async def test_pre_network_refuses_a_connection_as_a_closed_port(port):
    watch = _Watch(refused=("127.0.0.1",))
    line = "curl -sS http://127.0.0.1:{port}/a"
    assert await _held(port, line, watch) == 7
    assert (
        await _held(port, "wget -q -O - http://127.0.0.1:{port}/", watch) == 4
    )
    asked = watch.asked[0]
    assert (asked.address, asked.port, asked.command, asked.program) == (
        "127.0.0.1",
        port,
        "curl",
        ("curl",),
    )
    assert asked.line == f"curl -sS http://127.0.0.1:{port}/a"
    assert [w.text for w in asked.words] == [
        "curl",
        "-sS",
        f"http://127.0.0.1:{port}/a",
    ]
    assert [ctx.command for ctx in watch.asked] == ["curl", "wget"]
    assert watch.ended == []


@pytest.mark.asyncio
async def test_a_name_reaches_the_hooks_as_its_host(port):
    watch = _Watch()
    assert await _held(port, "curl -sS http://localhost:{port}/", watch) == 0
    assert (watch.asked[0].host, watch.asked[0].port) == ("localhost", port)


@pytest.mark.asyncio
async def test_post_network_sees_how_each_connection_went(port):
    watch = _Watch()
    line = (
        "curl -sS http://127.0.0.1:{port}/ > /data/a; "
        "curl -sS -o /data/b http://127.0.0.1:{port}/"
    )
    assert await _held(port, line, watch) == 0
    assert [(e.bytes_received, e.ended) for e in watch.ended] == [
        (len(_ANSWER), "closed"),
        (len(_ANSWER), "closed"),
    ]
    assert all(e.bytes_sent > 0 and e.seconds >= 0 for e in watch.ended)
    assert watch.open == 0


async def _keep_alive(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    try:
        while await reader.read(1024):
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok\n")
            await writer.drain()
    finally:
        writer.close()


class _Offline(Policy):
    """Refuses each connection a line naming `offline` opens."""

    async def pre_network(self, ctx: NetworkContext) -> Deny | None:
        return Deny("offline") if "offline" in ctx.line else None


@pytest.mark.asyncio
@pytest.mark.parametrize("setting", [True, {"allowed_domains": ["127.0.0.1"]}])
async def test_each_line_is_judged_on_a_server_that_keeps_sockets_alive(
    setting,
):
    server = await asyncio.start_server(_keep_alive, "127.0.0.1", 0)
    url = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}/"
    ws = Workspace({"/data": RAMVFS()}, network=setting)
    ws.policies.add(_Offline())
    try:
        assert (await ws.shell(f"curl -sS {url}")).exit_code == 0
        line = f"echo offline >/dev/null; curl -sS {url}"
        assert (await ws.shell(line)).exit_code == 7
    finally:
        await ws.close()
        server.close()


@pytest.mark.asyncio
async def test_the_lists_refuse_before_any_hook(port):
    watch = _Watch()
    line = "curl -sS http://127.0.0.1:{port}/"
    assert await _held(port, line, watch, network=False) == 7
    assert (watch.asked, watch.ended) == ([], [])


@pytest.mark.asyncio
async def test_post_network_reaches_each_policy_that_let_it_through(port):
    counted, refusing = _Watch(), _Watch(refused=("127.0.0.1",))
    line = "curl -sS http://127.0.0.1:{port}/"
    assert await _held(port, line, counted, refusing) == 7
    assert [e.ended for e in counted.ended] == ["refused"]
    assert (counted.open, refusing.open, refusing.ended) == (0, 0, [])


class _Quiet(Policy):
    """Answers with no action at all, and keeps how each connection
    ended."""

    def __init__(self) -> None:
        self.ended: list[NetworkResultContext] = []

    async def pre_network(self, ctx: NetworkContext) -> tuple[()]:
        return ()

    async def post_network(self, ctx: NetworkResultContext) -> None:
        self.ended.append(ctx)


@pytest.mark.asyncio
async def test_an_empty_answer_lets_a_connection_through_and_hears_it_end(
    port,
):
    quiet = _Quiet()
    assert await _held(port, "curl -sS http://127.0.0.1:{port}/", quiet) == 0
    assert [e.ended for e in quiet.ended] == ["closed"]


@pytest.mark.asyncio
async def test_a_limit_cuts_the_connection_with_a_reset(port):
    watch = _Watch(limit=Limit(max_bytes=40))
    line = "curl -sS http://127.0.0.1:{port}/"
    assert await _held(port, line, watch) != 0
    assert [e.ended for e in watch.ended] == ["limit"]
    assert watch.ended[0].bytes_sent + watch.ended[0].bytes_received == 40


async def _hold(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    await reader.read()
    writer.close()


@pytest_asyncio.fixture
async def silent():
    server = await asyncio.start_server(_hold, "127.0.0.1", 0)
    yield server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()


@pytest.mark.asyncio
async def test_a_limit_ends_a_connection_past_its_seconds(silent):
    watch = _Watch(limit=Limit(timeout_seconds=0.2))
    line = "curl -sS -m 5 http://127.0.0.1:{port}/"
    assert await _held(silent, line, watch) != 0
    assert [e.ended for e in watch.ended] == ["limit"]


@pytest.mark.asyncio
async def test_a_cancelled_command_still_ends_its_connection(silent):
    watch = _Watch()
    line = "timeout 0.3 curl -sS http://127.0.0.1:{port}/"
    assert await _held(silent, line, watch) == 124
    for _ in range(50):
        if watch.ended:
            break
        await asyncio.sleep(0.02)
    assert len(watch.ended) == 1
    assert watch.open == 0


class _Remote(RAMVFS):
    """A RAM mount whose listing first asks a server, as a remote VFS's
    client would."""

    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(b"GET / HTTP/1.1\r\nHost: remote\r\n\r\n")
        await reader.read()
        writer.close()
        return await super().readdir(path)


@pytest.mark.asyncio
async def test_a_mount_connection_names_its_mount_and_command(port):
    watch = _Watch()
    ws = Workspace({"/remote": _Remote(port)})
    ws.policies.add(watch)
    try:
        assert (await ws.shell("ls /remote")).exit_code == 0
    finally:
        await ws.close()
    assert [(c.mount, c.command, c.port) for c in watch.asked] == [
        ("/remote", "ls", port)
    ]
    assert [e.ended for e in watch.ended] == ["closed"]


@pytest.mark.asyncio
async def test_a_cli_connection_names_its_program_and_words(port):
    async def deploy(accessor, paths, texts, ctx):
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        writer.write(b"GET / HTTP/1.1\r\nHost: acme\r\n\r\n")
        await reader.read()
        writer.close()
        return None, IOResult()

    watch = _Watch()
    ws = Workspace({"/data": RAMVFS()})
    ws.register_cli(
        "acme",
        CLI(
            spec=CommandSpec(
                name="acme", subcommands=(CommandSpec(name="deploy"),)
            ),
            handlers={"deploy": CLIHandler(fn=deploy)},
        ),
    )
    ws.policies.add(watch)
    try:
        assert (await ws.shell("acme deploy")).exit_code == 0
    finally:
        await ws.close()
    [asked] = watch.asked
    assert (asked.command, asked.program, asked.line) == (
        "acme",
        ("acme", "deploy"),
        "acme deploy",
    )
    assert [w.text for w in asked.words] == ["acme", "deploy"]


@pytest.mark.asyncio
async def test_a_bound_socket_is_refused_while_a_policy_listens(port):
    async def bound(accessor, paths, texts, ctx):
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        try:
            sock.connect(("127.0.0.1", port))
        except PermissionError:
            return b"refused", IOResult()
        finally:
            sock.close()
        return b"connected", IOResult()

    ws = Workspace({"/data": RAMVFS()})
    ws.register_cli(
        "bound",
        CLI(
            spec=CommandSpec(name="bound"), handlers={"": CLIHandler(fn=bound)}
        ),
    )
    ws.policies.add(_Watch())
    try:
        assert (await ws.shell("bound")).stdout == b"refused"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_each_address_a_connection_falls_back_to_is_judged(
    port, monkeypatch
):
    resolve = network._resolve

    def two(host, *args, **kwargs):
        name = host.decode() if isinstance(host, bytes) else host
        if name != "two.test":
            return resolve(host, *args, **kwargs)
        first = resolve("127.0.0.1", *args, **kwargs)
        far = [(*info[:4], ("10.255.255.1", *info[4][1:])) for info in first]
        return far + first

    monkeypatch.setattr(network, "_resolve", two)
    watch = _Watch(refused=("10.255.255.1",))
    line = "curl -sS http://two.test:{port}/"
    assert await _held(port, line, watch) == 0
    assert [(c.host, c.address) for c in watch.asked] == [
        ("two.test", "10.255.255.1"),
        ("two.test", "127.0.0.1"),
    ]
    assert [(e.address, e.ended) for e in watch.ended] == [
        ("127.0.0.1", "closed")
    ]


class _Streaming(RAMVFS):
    """A RAM mount whose read asks a server between its two chunks, as a
    remote VFS's client fetches the rest of a file."""

    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port

    async def _chunks(self) -> AsyncIterator[bytes]:
        yield b"a"
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(b"GET / HTTP/1.1\r\nHost: remote\r\n\r\n")
        await reader.read()
        writer.close()
        yield b"b"

    def read(
        self, path: PathSpec, offset: int = 0, size: int | None = None
    ) -> AsyncIterator[bytes]:
        return self._chunks()


@pytest.mark.asyncio
async def test_a_file_stream_keeps_its_egress_past_the_op(port):
    watch = _Watch()
    ws = Workspace({"/remote": _Streaming(port)})
    ws.policies.add(watch)
    try:
        stream, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/remote/f"), stream=True
        )
        assert b"".join([chunk async for chunk in stream]) == b"ab"
    finally:
        await ws.close()
    assert [(c.mount, c.port) for c in watch.asked] == [("/remote", port)]


@pytest.mark.asyncio
async def test_an_unread_file_stream_still_lets_its_mount_go(port):
    ws = Workspace({"/remote": _Streaming(port)})
    ws.policies.add(_Watch())
    try:
        stream, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/remote/f"), stream=True
        )
        await stream.aclose()
        await asyncio.wait_for(ws.unmount("/remote"), 5)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_saved_process_substitution_keeps_its_bytes_under_a_rule():
    ws = Workspace({"/data": RAMVFS()}, network=False)
    try:
        line = "f() { exec 3<\"$1\"; }; f <(printf 'a\\nb\\n'); cat <&3"
        assert (await ws.shell(line)).stdout == b"a\nb\n"
    finally:
        await ws.close()


class _Following(RAMVFS):
    """A RAM mount whose follow asks a server between two lines, as a
    remote VFS's change stream polls for what is new."""

    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port

    async def follow(
        self, path: PathSpec, n: int, interval: float
    ) -> AsyncIterator[bytes]:
        port = self.port

        async def lines() -> AsyncIterator[bytes]:
            yield b"a\n"
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"GET / HTTP/1.1\r\nHost: remote\r\n\r\n")
            await reader.read()
            writer.close()
            yield b"b\n"

        return lines()


@pytest.mark.asyncio
async def test_a_follow_stream_keeps_its_egress_past_the_op(port):
    watch = _Watch()
    ws = Workspace({"/remote": (_Following(port), MountMode.WRITE)})
    ws.policies.add(watch)
    try:
        await ws.shell("echo x > /remote/f")
        stream, _ = await ws.dispatch(
            "follow", PathSpec.from_str_path("/remote/f"), n=1, interval=1.0
        )
        assert [chunk async for chunk in stream] == [b"a\n", b"b\n"]
    finally:
        await ws.close()
    assert [(c.mount, c.port) for c in watch.asked] == [("/remote", port)]


class _Cleanup:
    """A follow's stream whose close tells the server it is done, as a
    change stream drops its cursor."""

    def __init__(self, port: int) -> None:
        self.port = port

    def __aiter__(self) -> "_Cleanup":
        return self

    async def __anext__(self) -> bytes:
        raise StopAsyncIteration

    async def aclose(self) -> None:
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(b"GET / HTTP/1.1\r\nHost: remote\r\n\r\n")
        await reader.read()
        writer.close()


class _Unsubscribing(RAMVFS):
    def __init__(self, port: int) -> None:
        super().__init__()
        self.port = port

    async def follow(
        self, path: PathSpec, n: int, interval: float
    ) -> AsyncIterator[bytes]:
        return _Cleanup(self.port)


@pytest.mark.asyncio
async def test_a_follow_close_runs_as_the_stream_owner(port):
    watch = _Watch()
    ws = Workspace({"/remote": (_Unsubscribing(port), MountMode.WRITE)})
    ws.policies.add(watch)
    try:
        await ws.shell("echo x > /remote/f")
        stream, _ = await ws.dispatch(
            "follow", PathSpec.from_str_path("/remote/f"), n=1, interval=1.0
        )
        await stream.aclose()
    finally:
        await ws.close()
    assert [(c.mount, c.port) for c in watch.asked] == [("/remote", port)]
