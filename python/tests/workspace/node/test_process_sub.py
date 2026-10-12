import asyncio
from collections.abc import AsyncIterator

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.shell.console import Channel, JobConsole
from mirage.types import MountMode, PathSpec
from mirage.vfs.dev.dev import DevVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class BarrierVFS(RAMVFS):
    def __init__(self):
        super().__init__()
        self._store.files["/source"] = b"firstlast"
        self.release = asyncio.Event()
        self.started = asyncio.Event()
        self.closed = asyncio.Event()

    async def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        try:
            self.started.set()
            yield b"first"
            await self.release.wait()
            yield b"last"
        finally:
            self.closed.set()


class FirstByte(JobConsole):
    def __init__(self):
        super().__init__()
        self.first = asyncio.Event()
        self.out = b""
        self.err = b""

    async def emit(self, channel: Channel, data: bytes) -> None:
        if channel == Channel.STDOUT:
            self.out += data
            if data:
                self.first.set()
        else:
            self.err += data


def assert_released(ws):
    dev, _, _ = ws.registry.resolve("/dev/null")
    assert isinstance(dev, DevVFS)
    assert dev._store.files.state.inputs == {}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        "cat <(cat /data/source)",
        "cat < <(cat /data/source)",
        "cat /data/source > >(cat)",
    ],
)
async def test_first_byte_arrives_before_producer_finishes(command):
    data, sink = BarrierVFS(), FirstByte()
    ws = Workspace({"/data": data}, mode=MountMode.WRITE)
    running = asyncio.create_task(ws.shell(command, sink=sink))
    try:
        await asyncio.wait_for(sink.first.wait(), 3)
        assert sink.out == b"first"
        assert not running.done()
        data.release.set()
        io = await asyncio.wait_for(running, 3)
        assert io.exit_code == 0
        assert (sink.out, sink.err) == (b"firstlast", b"")
        assert_released(ws)
    finally:
        data.release.set()
        if not running.done():
            running.cancel()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    ["head -c 1 <(cat /data/source)", "head -c 1 < <(cat /data/source)"],
)
async def test_early_reader_closes_producer(command):
    data = BarrierVFS()
    ws = Workspace({"/data": data}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 3)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, "f", "")
        await asyncio.wait_for(data.closed.wait(), 3)
        assert_released(ws)
    finally:
        data.release.set()
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command", ["cat <(cat /data/source)", "cat /data/source > >(cat)"]
)
async def test_cancel_joins_children_and_releases_descriptors(command):
    data = BarrierVFS()
    ws = Workspace({"/data": data}, mode=MountMode.WRITE)
    running = asyncio.create_task(ws.shell(command))
    try:
        await asyncio.wait_for(data.started.wait(), 3)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
        await asyncio.wait_for(data.closed.wait(), 3)
        assert_released(ws)
    finally:
        data.release.set()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ("head -c 200000 /dev/zero > >(wc -c)", "200000\n"),
        ("head -c 1 <(head -c 200000 /dev/zero)", "\0"),
        ("cat <(cat <(echo nested))", "nested\n"),
        ("cat <(echo a) <(echo b)", "a\nb\n"),
        ("printf tail > >(cat); wait", "tail"),
        (
            "printf data > >(cat > /dev/null; false); echo status:$?; wait",
            "status:0\n",
        ),
        (
            'x=parent; printf data > >(cat > /dev/null; x=child); echo "$x"',
            "parent\n",
        ),
        ("stat -c %F <(echo hi); stat -c %F >(cat)", "fifo\nfifo\n"),
        (": <(cat /dev/zero); echo after", "after\n"),
    ],
)
async def test_pipe_lifecycle(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, expected, "")
        assert_released(ws)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_process_substitution_keeps_stdin_separate_and_releases_paths():
    ws = Workspace({}, mode=MountMode.WRITE)
    try:
        io = await ws.shell(
            "printf 'outer\\n' | cat <(echo one) - <(echo two); echo /dev/fd/*"
        )
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == (0, "one\nouter\ntwo\n/dev/fd/*\n", "")
    finally:
        await ws.close()


class FailingVFS(RAMVFS):
    def __init__(self):
        super().__init__()
        self._store.files["/bad"] = b"firstrest"

    async def read_stream(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> AsyncIterator[bytes]:
        yield b"first"
        raise PermissionError(13, "Permission denied", path.virtual)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        (": < <(sleep 30); echo after", (0, "after\n", "")),
        ("true <(sleep 30); echo after", (0, "after\n", "")),
        (
            "head -c 200000 /dev/zero > >(head -c 1 > /dev/null);"
            " echo st:$?; echo after",
            (0, "st:141\nafter\n", ""),
        ),
        (
            "f() { head -c 200000 /dev/zero > >(head -c 1 > /dev/null);"
            " echo st:$?; }; f; echo after",
            (0, "st:141\nafter\n", ""),
        ),
        (
            "printf '%0200000d' 0 > >(head -c 1 > /dev/null); echo after",
            (141, "", ""),
        ),
        ("printf data > >(true); echo after:$?", (0, "after:0\n", "")),
        (
            "{ printf a >&3; printf b; } 3>&1 < <(printf x); echo",
            (0, "ab\n", ""),
        ),
        (
            "f() { cat <(local y=child; printf '%s' \"$y\"); }; f",
            (0, "child", ""),
        ),
        (
            "(set -C; echo hi > >(cat); st=$?; wait; echo st:$st;"
            " echo x > /dev/null; echo null:$?)",
            (0, "hi\nst:0\nnull:0\n", ""),
        ),
        (
            "exec 3< <(printf a); echo st:$?",
            (
                0,
                "st:2\n",
                "mirage: unsupported: exec onto a process substitution\n",
            ),
        ),
    ],
)
async def test_redirect_lifecycle(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == expected
        assert_released(ws)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_file_read_failing_midway_fails_the_redirect_alone():
    ws = Workspace({"/data": FailingVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(
            ws.shell("cat < /data/bad; echo after:$?"), 5
        )
        assert (io.exit_code, await io.stdout_str()) == (0, "after:1\n")
        assert "Permission denied" in await io.stderr_str()
    finally:
        await ws.close()
