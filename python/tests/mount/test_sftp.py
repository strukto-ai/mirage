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
import inspect
import io
import stat
import struct
from dataclasses import replace

import asyncssh
import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.context import bind_caller, current_caller, reset_caller
from mirage.mount.sftp import (
    MirageSFTPServer,
    PipeServer,
    filetype,
    to_attrs,
)
from mirage.mount.types import MountAttrs

# The base-class members that never touch the host filesystem: accessors
# and formatting helpers. Every other method of asyncssh.SFTPServer serves
# the local disk unless overridden, so the guard below must see each one
# redefined on MirageSFTPServer.
HOST_SAFE = {
    "__init__",
    "channel",
    "connection",
    "env",
    "logger",
    "convert_attrs",
    "format_user",
    "format_group",
    "format_longname",
}

# SFTP v3 packet types, open flags and status codes the pipe tests use.
FXP_INIT = 1
FXP_OPEN = 3
FXP_CLOSE = 4
FXP_WRITE = 6
FXP_STAT = 17
FXP_SYMLINK = 20
FXP_VERSION = 2
FXP_STATUS = 101
FXP_HANDLE = 102
FXP_ATTRS = 105
FXF_WRITE = 0x02
FXF_CREAT = 0x08
FXF_TRUNC = 0x10
FX_NO_SUCH_FILE = 2
FX_OK = 0


def test_every_host_reaching_method_is_overridden():
    base = {
        name
        for name, member in vars(asyncssh.SFTPServer).items()
        if inspect.isfunction(member) and not name.startswith("_")
    }
    exposed = sorted(base - HOST_SAFE - set(vars(MirageSFTPServer)))
    assert not exposed, (
        "asyncssh.SFTPServer serves the host filesystem from these; "
        f"override them on MirageSFTPServer: {exposed}"
    )


def test_attrs_carry_type_mode_size_and_split_times():
    st = MountAttrs(
        mode=stat.S_IFREG | 0o640,
        size=12,
        nlink=1,
        uid=501,
        gid=20,
        rdev=0,
        atime=1_700_000_000_123_456_789,
        mtime=1_700_000_001_000_000_005,
        ctime=1_700_000_001_000_000_005,
    )
    attrs = to_attrs(st)
    assert attrs.type == filetype(stat.S_IFREG)
    assert (attrs.size, attrs.permissions) == (12, stat.S_IFREG | 0o640)
    assert (attrs.atime, attrs.atime_ns) == (1_700_000_000, 123_456_789)
    assert (attrs.mtime, attrs.mtime_ns) == (1_700_000_001, 5)


class Feed:
    """The server's writer: what it writes, the client reads."""

    def __init__(self, reader: asyncio.StreamReader) -> None:
        self.reader = reader

    def write(self, data: bytes) -> None:
        self.reader.feed_data(data)

    def close(self) -> None:
        self.reader.feed_eof()


def packet(kind: int, body: bytes) -> bytes:
    return struct.pack(">IB", len(body) + 1, kind) + body


def string(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


async def answer(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    (size,) = struct.unpack(">I", await reader.readexactly(4))
    data = await reader.readexactly(size)
    return data[0], data[1:]


async def stat_of(
    requests: asyncio.StreamReader,
    answers: asyncio.StreamReader,
    ident: int,
    path: str,
) -> tuple[int, bytes]:
    name = path.encode()
    requests.feed_data(
        packet(FXP_STAT, struct.pack(">II", ident, len(name)) + name)
    )
    return await answer(answers)


@pytest.mark.asyncio
async def test_a_pipe_answers_as_its_session():
    ws = Workspace(
        {"/notes": RAMVFS()},
        mode=MountMode.WRITE,
        profiles={"agent": {"paths": {"hide": ["/notes/secret.txt"]}}},
    )
    await ws.vfs.write("/notes/plan.txt", b"plan")
    await ws.vfs.write("/notes/secret.txt", b"salaries")
    await ws.session("agent", profile="agent")
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    served = asyncio.create_task(
        PipeServer(ws.vfs, ws.get_session("agent")).serve(
            requests, Feed(answers)
        )
    )
    requests.feed_data(packet(FXP_INIT, struct.pack(">I", 3)))
    kind, body = await answer(answers)
    assert (kind, struct.unpack(">I", body[:4])[0]) == (FXP_VERSION, 3)
    kind, body = await stat_of(requests, answers, 1, "/notes/plan.txt")
    assert kind == FXP_ATTRS
    kind, body = await stat_of(requests, answers, 2, "/notes/secret.txt")
    assert kind == FXP_STATUS
    assert struct.unpack(">II", body[:8]) == (2, FX_NO_SUCH_FILE)
    requests.feed_eof()
    await asyncio.wait_for(served, 5)
    await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("target", [b"real", b"missing"])
async def test_a_pipe_accepts_sshfs_symlink_wire_order(target):
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.vfs.write("/notes/real", b"target")
    await ws.session("agent")
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    served = asyncio.create_task(
        PipeServer(ws.vfs, ws.get_session("agent")).serve(
            requests, Feed(answers)
        )
    )
    try:
        requests.feed_data(packet(FXP_INIT, struct.pack(">I", 3)))
        await answer(answers)
        link = b"/notes/link"
        requests.feed_data(
            packet(
                FXP_SYMLINK,
                struct.pack(">I", 1)
                + struct.pack(">I", len(target))
                + target
                + struct.pack(">I", len(link))
                + link,
            )
        )
        kind, body = await answer(answers)
        assert (kind, struct.unpack(">II", body[:8])) == (
            FXP_STATUS,
            (1, FX_OK),
        )
        assert (
            await ws.shell("readlink /notes/link")
        ).stdout == target + b"\n"
        if target == b"real":
            assert await ws.vfs.read("/notes/link") == b"target"
    finally:
        requests.feed_eof()
        await asyncio.wait_for(served, 5)
        await ws.close()


@pytest.mark.asyncio
async def test_a_pipe_closed_before_it_speaks_ends_quietly():
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.session("agent")
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    requests.feed_eof()
    await asyncio.wait_for(
        PipeServer(ws.vfs, ws.get_session("agent")).serve(
            requests, Feed(answers)
        ),
        5,
    )
    await ws.close()


async def request(
    requests: asyncio.StreamReader,
    answers: asyncio.StreamReader,
    kind: int,
    ident: int,
    body: bytes,
) -> tuple[int, bytes]:
    requests.feed_data(packet(kind, struct.pack(">I", ident) + body))
    return await answer(answers)


async def write_new(
    requests: asyncio.StreamReader,
    answers: asyncio.StreamReader,
    path: bytes,
    data: bytes,
) -> bytes:
    """Create ``path`` and write ``data`` to it, as sshfs would, leaving the
    handle open; returns the handle."""
    flags = FXF_WRITE | FXF_CREAT | FXF_TRUNC
    opened = string(path) + struct.pack(">II", flags, 0)
    kind, body = await request(requests, answers, FXP_OPEN, 1, opened)
    assert kind == FXP_HANDLE
    handle = body[8:]
    written = string(handle) + struct.pack(">Q", 0) + string(data)
    _, body = await request(requests, answers, FXP_WRITE, 2, written)
    assert body[:8] == struct.pack(">II", 2, FX_OK)
    return handle


@pytest.mark.asyncio
async def test_a_sync_lands_what_a_pipe_acknowledged_before_its_close():
    # sshfs answers close(2) once the write is acknowledged and sends the
    # close that lands it later, on its own: the sync between them lands it.
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.session("agent")
    server = PipeServer(ws.vfs, ws.get_session("agent"))
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    served = asyncio.create_task(server.serve(requests, Feed(answers)))
    try:
        requests.feed_data(packet(FXP_INIT, struct.pack(">I", 3)))
        await answer(answers)
        handle = await write_new(
            requests, answers, b"/notes/new.txt", b"made\n"
        )
        assert await ws.vfs.read("/notes/new.txt") == b""
        await server.sync()
        assert await ws.vfs.read("/notes/new.txt") == b"made\n"
        _, body = await request(
            requests, answers, FXP_CLOSE, 3, string(handle)
        )
        assert body[:8] == struct.pack(">II", 3, FX_OK)
        assert await ws.vfs.read("/notes/new.txt") == b"made\n"
    finally:
        requests.feed_eof()
        await asyncio.wait_for(served, 5)
        await ws.close()


@pytest.mark.asyncio
async def test_a_running_lines_request_lands_past_a_capture_waiting_for_it():
    # A request run with the running line's write admission lands while a
    # capture waits for that line, rather than wait on the capture the
    # line is holding up.
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.session("agent")
    line = asyncio.create_task(ws.shell("sleep 30"))
    while not ws._admitted:
        await asyncio.sleep(0)
    (stop,) = ws._admitted

    async def as_line(op):
        token = bind_caller(replace(current_caller(), stop=stop))
        try:
            return await op
        finally:
            reset_caller(token)

    server = PipeServer(ws.vfs, ws.get_session("agent"), as_line)
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    served = asyncio.create_task(server.serve(requests, Feed(answers)))
    capture = asyncio.create_task(ws.snapshot(io.BytesIO()))
    try:
        while ws._admitting.is_set():
            await asyncio.sleep(0)
        async with asyncio.timeout(5):
            requests.feed_data(packet(FXP_INIT, struct.pack(">I", 3)))
            await answer(answers)
            handle = await write_new(
                requests, answers, b"/notes/new.txt", b"made\n"
            )
            await request(requests, answers, FXP_CLOSE, 3, string(handle))
        assert await ws.vfs.read("/notes/new.txt") == b"made\n"
        assert not capture.done()
    finally:
        line.cancel()
        await asyncio.gather(line, return_exceptions=True)
        await asyncio.wait_for(capture, 5)
        requests.feed_eof()
        await asyncio.wait_for(served, 5)
        await ws.close()
