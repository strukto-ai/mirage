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
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestServer

from mirage import Workspace
from mirage.core.api.errors import ApiError
from mirage.core.discord.entry import (
    channel_dirname,
    channel_entry,
    guild_dirname,
    guild_entry,
    history_entry,
    member_entry,
    member_filename,
)
from mirage.fuse.fs import MirageFS
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.types import ContentType, FileStat, FileType, MountMode
from mirage.vfs.discord import DiscordConfig, DiscordVFS
from mirage.workspace.files import Files

GUILD_PAYLOAD = {"id": "G1", "name": "TestGuild"}
CHANNEL_PAYLOAD = {"id": "C1", "name": "general", "type": 0}
MEMBER_PAYLOAD = {"user": {"id": "U1", "username": "alice"}, "roles": []}

# Every dynamic level is a `name__id` dirname the tree itself mints, so
# the fixture mints them the same way; a bare name is not a path the
# classifier recognizes.
GUILD = guild_dirname(GUILD_PAYLOAD)
CHANNEL = channel_dirname(CHANNEL_PAYLOAD)
MEMBER = member_filename(MEMBER_PAYLOAD)
DATE = "2024-01-15"
FILE = "chat.jsonl"
CHANNEL_PATH = f"{GUILD}/channels/{CHANNEL}"
DATE_DIR_PATH = f"{CHANNEL_PATH}/{DATE}"
FILE_PATH = f"{DATE_DIR_PATH}/{FILE}"
MEMBER_PATH = f"{GUILD}/members/{MEMBER}"

PREFIX = "/discord"

FAKE_JSONL = (
    b'{"id":"1","content":"hello","author":{"username":"alice"}}\n'
    b'{"id":"2","content":"world","author":{"username":"bob"}}\n'
)

# The day lister records chat.jsonl's exact rendered size, so a sizeless
# entry is the sealed-day case, which is what getattr reports 0 for.
CHAT_ENTRY = FileStat(
    name=FILE,
    type=FileType.FILE,
    content=ContentType.TEXT,
    fingerprint=f"{CHANNEL_PAYLOAD['id']}:{DATE}:chat",
)


def _run(coro):
    return asyncio.run(coro)


def _make_world() -> tuple[DiscordVFS, Workspace]:
    # Seeding happens after the mount: the index a driver runs under
    # is the mount's, built when the VFS is placed.
    config = DiscordConfig(token="test-token")
    vfs = DiscordVFS(config=config)
    ws = Workspace({f"{PREFIX}/": vfs}, mode=MountMode.READ)
    index = ws.mount(PREFIX).index_store
    _run(index.set_dir(PREFIX, [(GUILD, guild_entry(GUILD_PAYLOAD))]))
    _run(index.put(f"{PREFIX}/{CHANNEL_PATH}", channel_entry(CHANNEL_PAYLOAD)))
    _run(
        index.put(
            f"{PREFIX}/{DATE_DIR_PATH}",
            history_entry(CHANNEL_PAYLOAD["id"], DATE),
        )
    )
    _run(index.put(f"{PREFIX}/{FILE_PATH}", CHAT_ENTRY))
    _run(index.put(f"{PREFIX}/{MEMBER_PATH}", member_entry(MEMBER_PAYLOAD)))
    # A seeded listing answers readdir without a lister, so the mount
    # serves these directories without reaching the API.
    _run(
        index.set_dir(
            f"{PREFIX}/{GUILD}/channels",
            [(CHANNEL, channel_entry(CHANNEL_PAYLOAD))],
        )
    )
    _run(
        index.set_dir(
            f"{PREFIX}/{CHANNEL_PATH}",
            [(DATE, history_entry(CHANNEL_PAYLOAD["id"], DATE))],
        )
    )
    _run(index.set_dir(f"{PREFIX}/{DATE_DIR_PATH}", [(FILE, CHAT_ENTRY)]))
    _run(
        index.set_dir(
            f"{PREFIX}/{GUILD}/members",
            [(MEMBER, member_entry(MEMBER_PAYLOAD))],
        )
    )
    return vfs, ws


@pytest.fixture
def world():
    return _make_world()


@pytest.fixture
def ops(world) -> Files:
    return world[1].vfs


@pytest.fixture
def fs(ops):
    return MirageFS(ops)


# ── ops.readdir ──────────────────────────────────


def test_ops_readdir_guild(ops):
    entries = _run(ops.readdir(f"{PREFIX}/{GUILD}/"))
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert "channels" in names
    assert "members" in names


def test_ops_readdir_channels(ops):
    entries = _run(ops.readdir(f"{PREFIX}/{GUILD}/channels/"))
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert CHANNEL in names


def test_ops_readdir_dates(ops):
    entries = _run(ops.readdir(f"{PREFIX}/{CHANNEL_PATH}/"))
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert DATE in names


def test_ops_readdir_members(ops):
    entries = _run(ops.readdir(f"{PREFIX}/{GUILD}/members/"))
    names = [e.rsplit("/", 1)[-1] for e in entries]
    assert MEMBER in names


# ── ops.stat ─────────────────────────────────────


def test_ops_stat_guild(ops):
    s = _run(ops.stat(f"{PREFIX}/{GUILD}"))
    assert s.type == FileType.DIRECTORY


def test_ops_stat_channel(ops):
    s = _run(ops.stat(f"{PREFIX}/{CHANNEL_PATH}"))
    assert s.type == FileType.DIRECTORY


def test_ops_stat_file(ops):
    s = _run(ops.stat(f"{PREFIX}/{FILE_PATH}"))
    assert s.content == ContentType.TEXT
    assert s.name == FILE


# ── ops.read ─────────────────────────────────────


def test_ops_read_jsonl(ops):
    with patch(
        "mirage.core.discord.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=FAKE_JSONL,
    ):
        data = _run(ops.read(f"{PREFIX}/{FILE_PATH}"))
    assert data == FAKE_JSONL
    assert b"hello" in data


def test_ops_read_member(ops):
    with patch(
        "mirage.core.discord.read.list_members",
        new_callable=AsyncMock,
        return_value=[{"user": {"id": "U1", "username": "alice"}}],
    ):
        data = _run(ops.read(f"{PREFIX}/{MEMBER_PATH}"))
    assert b"alice" in data


# ── ops.read prefix in index keys ────────────────


def test_ops_read_uses_prefix_for_index(ops):
    with patch(
        "mirage.core.discord.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=b"data",
    ) as mock_get:
        data = _run(ops.read(f"{PREFIX}/{FILE_PATH}"))
    assert data == b"data"
    mock_get.assert_called_once()


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


def test_fuse_getattr_unknown_size(fs):
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


def test_fuse_read_file(fs):
    with patch(
        "mirage.core.discord.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=FAKE_JSONL,
    ):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, 0, fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == FAKE_JSONL


def test_fuse_read_offset(fs):
    with patch(
        "mirage.core.discord.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=FAKE_JSONL,
    ):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 10, 0, fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == FAKE_JSONL[:10]


def test_fuse_read_beyond_eof(fs):
    with patch(
        "mirage.core.discord.read.get_history_jsonl",
        new_callable=AsyncMock,
        return_value=FAKE_JSONL,
    ):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, len(FAKE_JSONL), fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == b""


HTTP_MESSAGES = [
    {
        "id": "1196423538278400000",
        "content": "hello",
        "author": {"username": "alice"},
    },
    {
        "id": "1196423538278400001",
        "content": "world",
        "author": {"username": "bob"},
    },
]
HTTP_JSONL = (
    b'{"id":"1196423538278400000","content":"hello",'
    b'"author":{"username":"alice"}}\n'
    b'{"id":"1196423538278400001","content":"world",'
    b'"author":{"username":"bob"}}\n'
)
HTTP_PATH = f"{PREFIX}/{FILE_PATH}"


class _DiscordHTTP:
    def __init__(self):
        self.status = 403
        self.requests = []
        self.history_calls = 0

    async def request(self, request):
        assert request.headers["Authorization"] == "Bot test-token"
        self.requests.append(request.path)
        if request.path == "/users/@me/guilds":
            return web.json_response([GUILD_PAYLOAD])
        if request.path == "/guilds/G1/channels":
            return web.json_response(
                [
                    {
                        **CHANNEL_PAYLOAD,
                        "last_message_id": HTTP_MESSAGES[-1]["id"],
                    }
                ]
            )
        assert request.path == "/channels/C1/messages"
        self.history_calls += 1
        if self.status != 200:
            return web.json_response(
                {"message": "refused", "retry_after": 0},
                status=self.status,
            )
        return web.json_response(list(reversed(HTTP_MESSAGES)))


class _DiscordReader:
    def __init__(self, backend, ws, http, use_fuse):
        self.backend = backend
        self.ws = ws
        self.http = http
        session = ws.create_session("reader")
        self.fuse = MirageFS(ws.vfs, session=session) if use_fuse else None
        self.core = (
            self.fuse.core
            if self.fuse is not None
            else MountCore(ws.vfs, session=session)
        )
        self.opened = []

    async def seal(self):
        stat = await self.ws.vfs.stat(HTTP_PATH)
        assert stat.size is None
        assert self.http.history_calls > 0

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
async def http_reader(request):
    http = _DiscordHTTP()
    app = web.Application()
    app.router.add_get("/{path:.*}", http.request)
    async with TestServer(app) as server:
        backend = DiscordVFS(
            config=DiscordConfig(
                token="test-token", base_url=str(server.make_url(""))
            )
        )
        ws = Workspace({f"{PREFIX}/": backend}, mode=MountMode.READ)
        reader = _DiscordReader(backend, ws, http, request.param == "fuse")
        try:
            yield reader
        finally:
            await reader.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("early_close", [False, True])
async def test_http_sealed_day_hydrates_exact_bytes_and_releases(
    http_reader, early_close
):
    reader = http_reader
    await reader.seal()
    assert await reader.size() == 0
    reader.http.status = 200
    before = reader.http.history_calls
    fh = await reader.open()
    assert reader.http.history_calls == before + 1
    assert await reader.size(fh) == len(HTTP_JSONL)
    if early_close:
        assert await reader.read(fh, 9, 3) == HTTP_JSONL[3:12]
    else:
        assert await reader.read(fh) == HTTP_JSONL
        assert await reader.read(fh, 9, len(HTTP_JSONL)) == b""
    await reader.release(fh)
    assert reader.http.history_calls == before + 1


@pytest.mark.asyncio
@pytest.mark.parametrize("status,attempts", [(401, 1), (403, 1), (429, 3)])
@pytest.mark.parametrize("recover", [False, True])
async def test_http_failure_is_deferred_to_read_and_does_not_cache_empty(
    http_reader, status, attempts, recover
):
    reader = http_reader
    await reader.seal()
    reader.http.status = status
    before = reader.http.history_calls
    fh = await reader.open()
    assert fh in reader.core.handles
    assert reader.http.history_calls == before + attempts
    with pytest.raises((ApiError, RuntimeError, OSError)) as failure:
        await reader.read(fh)
    assert reader.http.history_calls == before + 2 * attempts
    error = failure.value
    if reader.fuse is not None:
        assert isinstance(error, OSError)
        assert error.errno == errno.EIO
        error = error.__cause__
    assert classify_error(error) == errno.EIO
    if status == 429:
        assert isinstance(error, RuntimeError)
        assert str(error) == "Rate limited after 3 retries"
    else:
        assert isinstance(error, ApiError)
        assert error.status == status
    if recover:
        reader.http.status = 200
        assert await reader.read(fh) == HTTP_JSONL
    await reader.release(fh)
    assert reader.http.history_calls == before + 2 * attempts + int(recover)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,code", [("hide", errno.ENOENT), ("deny", errno.EACCES)]
)
async def test_http_hydrated_handle_obeys_new_policy_before_retained_bytes(
    http_reader, kind, code
):
    reader = http_reader
    await reader.seal()
    reader.http.status = 200
    fh = await reader.open()
    assert await reader.read(fh) == HTTP_JSONL
    before = len(reader.http.requests)
    profile = (
        {"paths": {"hide": [HTTP_PATH]}}
        if kind == "hide"
        else {
            "commands": {"deny": [{"paths": [HTTP_PATH], "reason": "sealed"}]}
        }
    )
    await reader.ws.set_session_profile("reader", profile)
    with pytest.raises(OSError) as failure:
        await reader.read(fh)
    assert failure.value.errno == code
    if kind == "hide":
        with pytest.raises(OSError) as hidden:
            await reader.size(fh)
        assert hidden.value.errno == errno.ENOENT
    assert len(reader.http.requests) == before
    await reader.ws.set_session_profile("reader", {})
    assert await reader.read(fh) == HTTP_JSONL
    assert len(reader.http.requests) == before
    await reader.release(fh)
