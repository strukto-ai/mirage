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
import stat
import struct

import asyncssh
import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.mount.constants import LISTING_CONCURRENCY
from mirage.mount.sftp import (
    MirageSFTPServer,
    filetype,
    listing,
    serve_pipe,
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

# SFTP v3 packet types and the one status code the pipe tests read.
FXP_INIT = 1
FXP_STAT = 17
FXP_VERSION = 2
FXP_STATUS = 101
FXP_ATTRS = 105
FX_NO_SUCH_FILE = 2


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


class ListingCore:
    """MountCore double: hold the first batch until the cap is full."""

    def __init__(self, names, refuse=None):
        self.names = names
        self.refuse = refuse
        self.started = asyncio.Barrier(LISTING_CONCURRENCY)
        self.now = 0
        self.peak = 0
        self.calls = 0
        self.tasks = 0

    async def readdir(self, path):
        return [".", ".."] + self.names

    async def getattr(self, path):
        self.calls += 1
        self.now += 1
        self.peak = max(self.peak, self.now)
        self.tasks = max(self.tasks, len(asyncio.all_tasks()))
        try:
            if self.calls <= LISTING_CONCURRENCY:
                async with asyncio.timeout(5):
                    await self.started.wait()
            else:
                await asyncio.sleep(0)
        finally:
            self.now -= 1
        if path.endswith("gone"):
            raise FileNotFoundError(path)
        if self.refuse is not None and path.endswith(self.refuse):
            raise PermissionError(path)
        return {"st_size": len(path)}


@pytest.mark.asyncio
async def test_listing_stats_entries_together_under_the_cap():
    # Each stat is, on an unindexed mount, a backend request: a wide
    # directory must not pay them one after another, nor put them all on
    # the wire at once.
    names = [f"f{i}" for i in range(40)] + ["gone"]
    core = ListingCore(names)
    rows = await listing(core, "/d")
    assert [name for name, _ in rows] == [".", ".."] + names[:-1]
    assert rows[2] == ("f0", {"st_size": len("/d/f0")})
    assert core.peak == LISTING_CONCURRENCY
    assert core.tasks <= LISTING_CONCURRENCY + 1


@pytest.mark.asyncio
async def test_listings_at_once_share_one_cap():
    # Two channels listing together on one workspace share the cap rather
    # than each bringing one of its own.
    core = ListingCore([f"f{i}" for i in range(40)])
    await asyncio.gather(listing(core, "/d"), listing(core, "/d"))
    assert core.peak == LISTING_CONCURRENCY


@pytest.mark.asyncio
async def test_a_refused_stat_ends_the_listing_without_statting_the_rest():
    core = ListingCore([f"f{i}" for i in range(100)], refuse="/d/f2")
    with pytest.raises(PermissionError):
        await listing(core, "/d")
    assert core.now == 0
    assert core.calls < 3 * LISTING_CONCURRENCY


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
        serve_pipe(ws.vfs, ws.get_session("agent"), requests, Feed(answers))
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
async def test_a_pipe_closed_before_it_speaks_ends_quietly():
    ws = Workspace({"/notes": RAMVFS()}, mode=MountMode.WRITE)
    await ws.session("agent")
    requests, answers = asyncio.StreamReader(), asyncio.StreamReader()
    requests.feed_eof()
    await asyncio.wait_for(
        serve_pipe(ws.vfs, ws.get_session("agent"), requests, Feed(answers)),
        5,
    )
    await ws.close()
