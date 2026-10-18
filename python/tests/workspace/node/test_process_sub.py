import asyncio
from collections.abc import AsyncIterator

import pytest

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.shell.console import Channel, JobConsole
from mirage.types import MountMode, PathSpec
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


async def assert_released(ws):
    io = await ws.shell("echo /dev/fd/*")
    assert await io.stdout_str() == "/dev/fd/*\n"


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
        await assert_released(ws)
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
        await assert_released(ws)
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
        await assert_released(ws)
    finally:
        data.release.set()
        await asyncio.gather(running, return_exceptions=True)
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ("head -c 1 <(head -c 200000 /dev/zero)", (0, "\0", "")),
        ("cat <(cat <(echo nested))", (0, "nested\n", "")),
        (": <(cat /dev/zero); echo after", (0, "after\n", "")),
        (
            "printf data > >(cat > /dev/null); echo after:$?",
            (0, "after:0\n", ""),
        ),
        (
            "head -c 200000 /dev/zero > >(head -c 1 > /dev/null); echo st:$?",
            (0, "st:141\n", ""),
        ),
        (
            "printf '%0200000d' 0 > >(head -c 1 > /dev/null); echo after",
            (141, "", ""),
        ),
        (
            "printf 'outer\\n' | cat <(echo one) - <(echo two)",
            (0, "one\nouter\ntwo\n", ""),
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
async def test_line_releases_its_descriptors(command, expected):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        io = await asyncio.wait_for(ws.shell(command), 5)
        assert (
            io.exit_code,
            await io.stdout_str(),
            await io.stderr_str(),
        ) == expected
        await assert_released(ws)
    finally:
        await ws.close()
