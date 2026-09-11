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
from unittest.mock import AsyncMock, patch

import pytest

from mirage import Workspace
from mirage.cache.index import IndexEntry
from mirage.core.discord.entry import (channel_dirname, channel_entry,
                                       guild_dirname, guild_entry,
                                       history_entry, member_entry,
                                       member_filename)
from mirage.fuse.fs import MirageFS
from mirage.ops import Ops
from mirage.resource.discord import DiscordConfig, DiscordResource
from mirage.types import ContentType, FileType, MountMode

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

FAKE_JSONL = (b'{"id":"1","content":"hello","author":{"username":"alice"}}\n'
              b'{"id":"2","content":"world","author":{"username":"bob"}}\n')

# The day lister records chat.jsonl's exact rendered size, so a sizeless
# entry is the sealed-day case, which is what getattr reports 0 for.
CHAT_ENTRY = IndexEntry(id=f"{CHANNEL_PAYLOAD['id']}:{DATE}:chat",
                        name=FILE,
                        resource_type="discord/chat_jsonl",
                        vfs_name=FILE)


def _run(coro):
    return asyncio.run(coro)


def _make_world() -> tuple[DiscordResource, Workspace]:
    # Seeding happens after the mount: installing a resource re-derives
    # its index from the workspace's config, so an index seeded before
    # is thrown away, and a second workspace over the same resource
    # would throw away this one.
    config = DiscordConfig(token="test-token")
    resource = DiscordResource(config=config)
    ws = Workspace({f"{PREFIX}/": resource}, mode=MountMode.READ)
    index = resource.index
    _run(index.put(f"{PREFIX}/{GUILD}", guild_entry(GUILD_PAYLOAD)))
    _run(index.put(f"{PREFIX}/{CHANNEL_PATH}", channel_entry(CHANNEL_PAYLOAD)))
    _run(
        index.put(f"{PREFIX}/{DATE_DIR_PATH}",
                  history_entry(CHANNEL_PAYLOAD["id"], DATE)))
    _run(index.put(f"{PREFIX}/{FILE_PATH}", CHAT_ENTRY))
    _run(index.put(f"{PREFIX}/{MEMBER_PATH}", member_entry(MEMBER_PAYLOAD)))
    # A seeded listing answers readdir without a lister, so the mount
    # serves these directories without reaching the API.
    _run(
        index.set_dir(f"{PREFIX}/{GUILD}/channels",
                      [(CHANNEL, channel_entry(CHANNEL_PAYLOAD))]))
    _run(
        index.set_dir(f"{PREFIX}/{CHANNEL_PATH}",
                      [(DATE, history_entry(CHANNEL_PAYLOAD["id"], DATE))]))
    _run(index.set_dir(f"{PREFIX}/{DATE_DIR_PATH}", [(FILE, CHAT_ENTRY)]))
    _run(
        index.set_dir(f"{PREFIX}/{GUILD}/members",
                      [(MEMBER, member_entry(MEMBER_PAYLOAD))]))
    return resource, ws


@pytest.fixture
def world():
    return _make_world()


@pytest.fixture
def ops(world) -> Ops:
    return world[1].fs


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
    with patch("mirage.core.discord.read.get_history_jsonl",
               new_callable=AsyncMock,
               return_value=FAKE_JSONL):
        data = _run(ops.read(f"{PREFIX}/{FILE_PATH}"))
    assert data == FAKE_JSONL
    assert b"hello" in data


def test_ops_read_member(ops):
    with patch("mirage.core.discord.read.list_members",
               new_callable=AsyncMock,
               return_value=[{
                   "user": {
                       "id": "U1",
                       "username": "alice"
                   }
               }]):
        data = _run(ops.read(f"{PREFIX}/{MEMBER_PATH}"))
    assert b"alice" in data


# ── ops.read prefix in index keys ────────────────


def test_ops_read_uses_prefix_for_index(ops):
    with patch("mirage.core.discord.read.get_history_jsonl",
               new_callable=AsyncMock,
               return_value=b"data") as mock_get:
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
    with patch("mirage.core.discord.read.get_history_jsonl",
               new_callable=AsyncMock,
               return_value=FAKE_JSONL):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, 0, fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == FAKE_JSONL


def test_fuse_read_offset(fs):
    with patch("mirage.core.discord.read.get_history_jsonl",
               new_callable=AsyncMock,
               return_value=FAKE_JSONL):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 10, 0, fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == FAKE_JSONL[:10]


def test_fuse_read_beyond_eof(fs):
    with patch("mirage.core.discord.read.get_history_jsonl",
               new_callable=AsyncMock,
               return_value=FAKE_JSONL):
        fh = fs.open(f"{PREFIX}/{FILE_PATH}", 0)
        data = fs.read(f"{PREFIX}/{FILE_PATH}", 4096, len(FAKE_JSONL), fh)
        fs.release(f"{PREFIX}/{FILE_PATH}", fh)
    assert data == b""
