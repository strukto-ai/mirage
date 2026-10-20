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
import struct
import subprocess
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio

from mirage import MountMode, Workspace
from mirage.mount import nfs
from mirage.mount.core import MountCore
from mirage.mount.nfs import MirageNFSServer, mount_args, unmount_args
from mirage.vfs.ram import RAMVFS

NFS = 100003
MOUNT = 100005
FATTR = 84


def opaque(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data + b"\0" * (-len(data) % 4)


class Reply:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.at = 0

    def u32(self) -> int:
        (value,) = struct.unpack_from(">I", self.body, self.at)
        self.at += 4
        return int(value)

    def u64(self) -> int:
        (value,) = struct.unpack_from(">Q", self.body, self.at)
        self.at += 8
        return int(value)

    def opaque(self) -> bytes:
        size = self.u32()
        data = self.body[self.at : self.at + size]
        self.at += size + (-size % 4)
        return data

    def fattr(self) -> tuple[int, int, int]:
        ftype, mode = struct.unpack_from(">II", self.body, self.at)
        (size,) = struct.unpack_from(">Q", self.body, self.at + 20)
        self.at += FATTR
        return int(ftype), int(mode), int(size)

    def post_op_attr(self) -> tuple[int, int, int] | None:
        return self.fattr() if self.u32() else None


class Client:
    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self.reader = reader
        self.writer = writer
        self.xid = 0

    async def call(self, prog: int, proc: int, args: bytes = b"") -> Reply:
        self.xid += 1
        body = (
            struct.pack(
                ">IIIIIIIIII", self.xid, 0, 2, prog, 3, proc, 0, 0, 0, 0
            )
            + args
        )
        self.writer.write(struct.pack(">I", len(body) | 0x8000_0000) + body)
        (header,) = struct.unpack(">I", await self.reader.readexactly(4))
        reply = Reply(await self.reader.readexactly(header & 0x7FFF_FFFF))
        assert [reply.u32() for _ in range(6)] == [self.xid, 1, 0, 0, 0, 0]
        return reply

    async def root(self) -> bytes:
        reply = await self.call(MOUNT, 1, opaque(b"/"))
        assert reply.u32() == 0
        return reply.opaque()

    async def lookup(self, directory: bytes, name: str) -> tuple[int, bytes]:
        reply = await self.call(
            NFS, 3, opaque(directory) + opaque(name.encode())
        )
        status = reply.u32()
        return status, reply.opaque() if status == 0 else b""

    async def handle(self, *names: str) -> bytes:
        handle = await self.root()
        for name in names:
            _, handle = await self.lookup(handle, name)
        return handle

    async def read(self, handle: bytes, offset: int, count: int) -> bytes:
        reply = await self.call(
            NFS, 6, opaque(handle) + struct.pack(">QI", offset, count)
        )
        assert reply.u32() == 0
        reply.post_op_attr()
        reply.u32()
        reply.u32()
        return reply.opaque()


class Counting(MountCore):
    def __init__(self, ws: Workspace) -> None:
        super().__init__(ws.vfs)
        self.opened: list[str] = []
        self.released: list[int] = []

    async def open(self, path: str, flags: int = 0) -> int:
        self.opened.append(path)
        return await super().open(path, flags)

    async def release(self, fh: int) -> None:
        self.released.append(fh)
        await super().release(fh)


@pytest_asyncio.fixture
async def client() -> AsyncIterator[Client]:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir -p /docs/sub && printf 'hello\\n' > /docs/a.txt")
    server = MirageNFSServer(MountCore(ws.vfs), secure=False)
    port = await server.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        yield Client(reader, writer)
    finally:
        writer.close()
        await server.close()


@pytest.mark.asyncio
async def test_getattr_of_the_mounted_root_is_a_directory(
    client: Client,
) -> None:
    root = await client.root()
    reply = await client.call(NFS, 1, opaque(root))
    assert reply.u32() == 0
    assert reply.fattr()[0] == 2


@pytest.mark.asyncio
async def test_lookup_then_read_returns_the_file_bytes(client: Client) -> None:
    root = await client.root()
    _, docs = await client.lookup(root, "docs")
    status, handle = await client.lookup(docs, "a.txt")
    assert status == 0
    reply = await client.call(
        NFS, 6, opaque(handle) + struct.pack(">QI", 0, 4096)
    )
    assert reply.u32() == 0
    assert reply.post_op_attr() == (1, 0o644, 6)
    count, eof = reply.u32(), reply.u32()
    assert (count, eof, reply.opaque()) == (6, 1, b"hello\n")


@pytest.mark.asyncio
async def test_readdirplus_lists_the_directory(client: Client) -> None:
    root = await client.root()
    _, docs = await client.lookup(root, "docs")
    args = opaque(docs) + struct.pack(">Q8sII", 0, b"\0" * 8, 4096, 32768)
    reply = await client.call(NFS, 17, args)
    assert reply.u32() == 0
    reply.post_op_attr()
    reply.u64()
    names = []
    while reply.u32():
        reply.u64()
        names.append(reply.opaque().decode())
        reply.u64()
        reply.post_op_attr()
        if reply.u32():
            reply.opaque()
    assert names == ["a.txt", "sub"]
    assert reply.u32() == 1


@pytest.mark.asyncio
async def test_lookup_of_a_missing_name_is_noent(client: Client) -> None:
    root = await client.root()
    status, _ = await client.lookup(root, "nope")
    assert status == 2


@pytest.mark.asyncio
async def test_a_write_is_refused_as_read_only(client: Client) -> None:
    root = await client.root()
    reply = await client.call(
        NFS, 9, opaque(root) + opaque(b"new") + b"\0" * 24
    )
    assert reply.u32() == 30


def test_linux_mounts_read_only_and_soft_on_the_servers_port() -> None:
    args = mount_args(2049, "/mnt/x", platform="linux")
    assert args[:3] == ["mount", "-t", "nfs"]
    assert args[-2:] == ["127.0.0.1:/", "/mnt/x"]
    options = args[4].split(",")
    assert {
        "vers=3",
        "soft",
        "ro",
        "nolock",
        "port=2049",
        "mountport=2049",
    } <= set(options)


def test_macos_mounts_with_mount_nfs_and_no_reserved_port() -> None:
    args = mount_args(2049, "/mnt/x", platform="darwin")
    assert args[0] == "/sbin/mount_nfs"
    options = args[2].split(",")
    assert {"vers=3", "soft", "rdonly", "noresvport", "port=2049"} <= set(
        options
    )


def test_other_platforms_are_refused() -> None:
    with pytest.raises(RuntimeError, match="Linux and macOS"):
        mount_args(2049, "/mnt/x", platform="win32")


def test_unmount_falls_back_to_a_forced_unmount() -> None:
    assert unmount_args("/mnt/x", platform="linux") == [
        ["umount", "/mnt/x"],
        ["umount", "-l", "/mnt/x"],
    ]
    assert unmount_args("/mnt/x", platform="darwin")[-1] == [
        "diskutil",
        "unmount",
        "force",
        "/mnt/x",
    ]


@pytest.mark.asyncio
async def test_a_secure_server_refuses_a_client_on_an_unreserved_port() -> (
    None
):
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    server = MirageNFSServer(MountCore(ws.vfs), secure=True)
    port = await server.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        assert await asyncio.wait_for(reader.read(), 5) == b""
    finally:
        writer.close()
        await server.close()


@pytest.mark.asyncio
async def test_reads_share_one_open_until_the_file_changes() -> None:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("printf 'hello world\\n' > /a.txt")
    core = Counting(ws)
    server = MirageNFSServer(core, secure=False)
    port = await server.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    client = Client(reader, writer)
    try:
        handle = await client.handle("a.txt")
        assert await client.read(handle, 0, 5) == b"hello"
        assert await client.read(handle, 6, 100) == b"world\n"
        assert core.opened == ["/a.txt"]
        await ws.shell("printf 'bye\\n' > /a.txt")
        await client.call(NFS, 1, opaque(handle))
        assert await client.read(handle, 0, 100) == b"bye\n"
        assert core.opened == ["/a.txt", "/a.txt"]
        assert len(core.released) == 1
    finally:
        writer.close()
        await server.close()
    assert len(core.released) == 2


@pytest.mark.asyncio
async def test_the_least_recently_read_file_is_released_past_the_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(nfs, "OPEN_HANDLES", 2)
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("for f in a b c; do echo $f > /$f; done")
    core = Counting(ws)
    server = MirageNFSServer(core, secure=False)
    port = await server.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    client = Client(reader, writer)
    try:
        for name in ("a", "b", "c"):
            handle = await client.handle(name)
            assert await client.read(handle, 0, 10) == f"{name}\n".encode()
        assert len(core.released) == 1
    finally:
        writer.close()
        await server.close()


def test_a_timed_out_unmount_falls_through_to_the_forced_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ran: list[list[str]] = []

    def run(args: list[str], **_: int) -> subprocess.CompletedProcess[str]:
        ran.append(args)
        if len(ran) == 1:
            raise subprocess.TimeoutExpired(args, 30)
        return subprocess.CompletedProcess(args, 0, "", "")

    monkeypatch.setattr(subprocess, "run", run)
    nfs.unmount_nfs("/mnt/x")
    assert ran == nfs.unmount_args("/mnt/x")
