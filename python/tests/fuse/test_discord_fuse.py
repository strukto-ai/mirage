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
import errno

import pytest
import pytest_asyncio

from mirage import Workspace
from mirage.core.api.errors import ApiError
from mirage.core.render.json import jsonl_bytes
from mirage.fuse.fs import MirageFS
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.types import ContentType, FileStat, FileType, MountMode
from mirage.vfs.discord import DiscordVFS
from mirage.workspace.files import Files
from tests.fixtures.discord_guild import (
    DAY,
    GENERAL,
    MESSAGES,
    DiscordGuild,
    discord_guild,
)

__all__ = ["discord_guild"]

GUILD = "My Server__111"
CHANNEL = "general__211"
MEMBER = "alice__311.json"
DATE = DAY
FILE = "chat.jsonl"
CHANNEL_PATH = f"{GUILD}/channels/{CHANNEL}"
DATE_DIR_PATH = f"{CHANNEL_PATH}/{DATE}"
FILE_PATH = f"{DATE_DIR_PATH}/{FILE}"
MEMBER_PATH = f"{GUILD}/members/{MEMBER}"

PREFIX = "/discord"
HTTP_PATH = f"{PREFIX}/{FILE_PATH}"


@pytest_asyncio.fixture
async def world(discord_guild: DiscordGuild):
    vfs = DiscordVFS(config=discord_guild.config())
    ws = Workspace({f"{PREFIX}/": vfs}, mode=MountMode.READ)
    yield vfs, ws
    await ws.close()


@pytest_asyncio.fixture
async def jsonl(discord_guild: DiscordGuild) -> bytes:
    """general's chat.jsonl for the day: Discord's own messages, oldest
    first."""
    return jsonl_bytes(await discord_guild.day(GENERAL, DATE))


@pytest.fixture
def ops(world) -> Files:
    return world[1].vfs


@pytest.fixture
def fs(world, ops):
    fs = MirageFS(ops)
    yield fs
    # The accessor's connections were opened on the FUSE loop, so they
    # are closed there before it stops.
    asyncio.run_coroutine_threadsafe(
        world[0].accessor.close(), fs._loop
    ).result()
    fs._loop.call_soon_threadsafe(fs._loop.stop)


# ── ops.readdir ──────────────────────────────────


@pytest.mark.asyncio
async def test_ops_readdir_guild(ops):
    entries = await ops.readdir(f"{PREFIX}/{GUILD}/")
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert "channels" in names
    assert "members" in names


@pytest.mark.asyncio
async def test_ops_readdir_channels(ops):
    entries = await ops.readdir(f"{PREFIX}/{GUILD}/channels/")
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert CHANNEL in names


@pytest.mark.asyncio
async def test_ops_readdir_dates(ops):
    entries = await ops.readdir(f"{PREFIX}/{CHANNEL_PATH}/")
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert DATE in names


@pytest.mark.asyncio
async def test_ops_readdir_members(ops):
    entries = await ops.readdir(f"{PREFIX}/{GUILD}/members/")
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert MEMBER in names


# ── ops.stat ─────────────────────────────────────


@pytest.mark.asyncio
async def test_ops_stat_guild(ops):
    s = await ops.stat(f"{PREFIX}/{GUILD}")
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_ops_stat_channel(ops):
    s = await ops.stat(f"{PREFIX}/{CHANNEL_PATH}")
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_ops_stat_file(ops):
    s = await ops.stat(f"{PREFIX}/{FILE_PATH}")
    assert s.content == ContentType.TEXT
    assert s.name == FILE


# ── ops.read ─────────────────────────────────────


@pytest.mark.asyncio
async def test_ops_read_jsonl(ops, jsonl):
    data = await ops.read(f"{PREFIX}/{FILE_PATH}")
    assert data == jsonl
    assert b"hello" in data


@pytest.mark.asyncio
async def test_ops_read_member(ops):
    data = await ops.read(f"{PREFIX}/{MEMBER_PATH}")
    assert b"alice" in data


# ── ops.read prefix in index keys ────────────────


@pytest.mark.asyncio
async def test_ops_read_uses_prefix_for_index(ops, jsonl, discord_guild):
    # The day's row is found under the mount's prefix, so the read fetches
    # the day it names.
    data = await ops.read(f"{PREFIX}/{FILE_PATH}")
    assert data == jsonl
    assert (GENERAL, DATE) in await discord_guild.day_fetches()


# ── FUSE getattr ─────────────────────────────────


def test_fuse_getattr_root(fs):
    attr = fs.getattr("/")
    assert attr["st_mode"] & 0o170000 == 0o040000


def test_fuse_getattr_mount_prefix(fs):
    attr = fs.getattr("/discord")
    assert attr["st_mode"] & 0o170000 == 0o040000


def test_fuse_getattr_guild(fs):
    attr = fs.getattr(f"{PREFIX}/{GUILD}")
    assert attr["st_mode"] & 0o170000 == 0o040000


def test_fuse_getattr_file(fs):
    attr = fs.getattr(f"{PREFIX}/{FILE_PATH}")
    assert attr["st_mode"] & 0o170000 == 0o100000


@pytest_asyncio.fixture
async def sizeless(world):
    # The day lister records chat.jsonl's exact rendered size; a sizeless
    # entry, which getattr reports 0 for, is only ever made by a test.
    index = world[1].mount(PREFIX).index_store
    chat = FileStat(name=FILE, type=FileType.FILE, content=ContentType.TEXT)
    await index.set_dir(f"{PREFIX}/{DATE_DIR_PATH}", [(FILE, chat)])


def test_fuse_getattr_unknown_size(sizeless, fs):
    # Unknown size before open() — direct_io ensures read() still works
    attr = fs.getattr(f"{PREFIX}/{FILE_PATH}")
    assert attr["st_size"] == 0


# ── FUSE readdir ─────────────────────────────────


def test_fuse_readdir_root(fs):
    entries = fs.readdir("/", None)
    assert "discord" in entries


def test_fuse_readdir_guild(fs):
    entries = fs.readdir(f"{PREFIX}/{GUILD}", None)
    assert "channels" in entries
    assert "members" in entries


def test_fuse_readdir_channels(fs):
    entries = fs.readdir(f"{PREFIX}/{GUILD}/channels", None)
    assert CHANNEL in entries


def test_fuse_readdir_dates(fs):
    entries = fs.readdir(f"{PREFIX}/{CHANNEL_PATH}", None)
    assert DATE in entries


# ── FUSE open + read ─────────────────────────────


def test_fuse_read_file(fs, jsonl):
    fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
    data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, 0, fh)
    fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == jsonl


def test_fuse_read_offset(fs, jsonl):
    fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
    data = fs.read(f"{PREFIX}/{FILE_PATH}", 10, 0, fh)
    fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == jsonl[:10]


def test_fuse_read_beyond_eof(fs, jsonl):
    fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
    data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, len(jsonl), fh)
    fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == b""


class _DiscordReader:
    def __init__(self, backend, ws, guild, jsonl, use_fuse):
        self.backend = backend
        self.ws = ws
        self.guild = guild
        self.jsonl = jsonl
        session = ws.create_session("reader")
        self.fuse = MirageFS(ws.vfs, session=session) if use_fuse else None
        self.core = (
            self.fuse.core
            if self.fuse is not None
            else MountCore(ws.vfs, session=session)
        )
        self.opened = []

    async def history_calls(self) -> int:
        return await self.guild.count(MESSAGES)

    async def list_day(self):
        stat = await self.ws.vfs.stat(HTTP_PATH)
        assert stat.size == len(self.jsonl)
        assert await self.history_calls() > 0

    async def size(self, fh=None):
        if self.fuse is not None:
            attrs = await asyncio.to_thread(self.fuse.getattr, HTTP_PATH, fh)
            return attrs["st_size"]
        return (await self.core.fgetattr(HTTP_PATH, fh)).size

    async def open(self):
        if self.fuse is not None:
            fh = await asyncio.to_thread(self.fuse.open, HTTP_PATH, 0)
        else:
            fh = await self.core.open(HTTP_PATH)
        self.opened.append(fh)
        return fh

    async def read(self, fh, size=4096, offset=0):
        if self.fuse is not None:
            return await asyncio.to_thread(
                self.fuse.read, HTTP_PATH, size, offset, fh
            )
        return await self.core.read(HTTP_PATH, size, offset, fh)

    async def release(self, fh):
        if self.fuse is not None:
            await asyncio.to_thread(self.fuse.release, HTTP_PATH, fh)
        else:
            await self.core.release(fh)
        assert fh not in self.core.handles

    async def close(self):
        for fh in self.opened:
            if fh in self.core.handles:
                await self.release(fh)
        session = self.backend.accessor.pool._session
        try:
            if session is not None:
                assert not session.closed
                assert session.connector is not None
                assert not session.connector._acquired
        finally:
            if self.fuse is not None:
                await asyncio.wrap_future(
                    asyncio.run_coroutine_threadsafe(
                        self.backend.accessor.close(), self.fuse._loop
                    )
                )
            await self.ws.close()
            assert session is None or session.closed
            if self.fuse is not None:
                loop = self.fuse._loop
                loop.call_soon_threadsafe(loop.stop)
                while loop.is_running():
                    await asyncio.sleep(0)
                loop.close()


@pytest_asyncio.fixture(params=["core", "fuse"])
async def http_reader(request, discord_guild, jsonl):
    backend = DiscordVFS(config=discord_guild.config())
    ws = Workspace({f"{PREFIX}/": backend}, mode=MountMode.READ)
    reader = _DiscordReader(
        backend, ws, discord_guild, jsonl, request.param == "fuse"
    )
    try:
        yield reader
    finally:
        await reader.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("early_close", [False, True])
async def test_http_listed_day_reads_exact_bytes_and_releases(
    http_reader, early_close
):
    reader = http_reader
    await reader.list_day()
    assert await reader.size() == len(reader.jsonl)
    before = await reader.history_calls()
    fh = await reader.open()
    assert await reader.history_calls() == before
    assert await reader.size(fh) == len(reader.jsonl)
    if early_close:
        assert await reader.read(fh, 9, 3) == reader.jsonl[3:12]
    else:
        assert await reader.read(fh) == reader.jsonl
        assert await reader.read(fh, 9, len(reader.jsonl)) == b""
    await reader.release(fh)
    assert await reader.history_calls() == before + 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,attempts,code",
    [(401, 1, errno.EACCES), (403, 1, errno.EACCES), (429, 3, errno.EIO)],
)
async def test_http_refused_day_fails_getattr_and_does_not_cache_empty(
    http_reader, status, attempts, code
):
    reader = http_reader
    await reader.guild.refuse(MESSAGES, status)
    with pytest.raises((ApiError, OSError)) as failure:
        await reader.size()
    assert classify_error(failure.value) == code
    assert await reader.history_calls() == attempts
    await reader.guild.run.clear_answers()
    assert await reader.size() == len(reader.jsonl)
    assert await reader.history_calls() == attempts + 1


@pytest.mark.asyncio
async def test_http_hydrated_handle_obeys_new_policy_before_retained_bytes(
    http_reader,
):
    reader = http_reader
    await reader.list_day()
    fh = await reader.open()
    assert await reader.read(fh) == reader.jsonl
    before = len(await reader.guild.run.requests())
    await reader.ws.set_session_profile(
        "reader", {"paths": {"hide": [HTTP_PATH]}}
    )
    with pytest.raises(OSError) as failure:
        await reader.read(fh)
    assert failure.value.errno == errno.ENOENT
    with pytest.raises(OSError) as hidden:
        await reader.size(fh)
    assert hidden.value.errno == errno.ENOENT
    assert len(await reader.guild.run.requests()) == before
    await reader.ws.set_session_profile("reader", {})
    assert await reader.read(fh) == reader.jsonl
    assert len(await reader.guild.run.requests()) == before
    await reader.release(fh)
