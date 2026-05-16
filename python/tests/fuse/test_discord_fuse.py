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

from mirage.cache.index import IndexEntry
from mirage.fuse.fs import MirageFS
from mirage.ops import Ops
from mirage.ops.config import OpsMount
from mirage.resource.discord import DiscordConfig, DiscordResource
from mirage.types import FileType, MountMode

GUILD = "TestGuild"
CHANNEL = "general"
DATE = "2024-01-15"
FILE = "chat.jsonl"
GUILD_PATH = f"{GUILD}"
CHANNEL_PATH = f"{GUILD}/channels/{CHANNEL}"
DATE_DIR_PATH = f"{GUILD}/channels/{CHANNEL}/{DATE}"
FILE_PATH = f"{GUILD}/channels/{CHANNEL}/{DATE}/{FILE}"
MEMBER_PATH = f"{GUILD}/members/alice.json"

PREFIX = "/discord"

FAKE_JSONL = (b'{"id":"1","content":"hello","author":{"username":"alice"}}\n'
              b'{"id":"2","content":"world","author":{"username":"bob"}}\n')

FAKE_MEMBER = b'{"user":{"id":"U1","username":"alice"},"roles":[]}'


def _run(coro):
    return asyncio.run(coro)


def _make_resource() -> DiscordResource:
    config = DiscordConfig(token="test-token")
    resource = DiscordResource(config=config)
    index = resource.index
    _run(
        index.put(
            f"{PREFIX}/{GUILD}",
            IndexEntry(id="G1",
                       name=GUILD,
                       resource_type="discord/guild",
                       vfs_name=GUILD)))
    _run(
        index.put(
            f"{PREFIX}/{CHANNEL_PATH}",
            IndexEntry(id="C1",
                       name=CHANNEL,
                       resource_type="discord/channel",
                       vfs_name=CHANNEL)))
    _run(
        index.put(
            f"{PREFIX}/{DATE_DIR_PATH}",
            IndexEntry(id="C1:2024-01-15",
                       name="2024-01-15",
                       resource_type="discord/history",
                       vfs_name=DATE)))
    _run(
        index.put(
            f"{PREFIX}/{FILE_PATH}",
            IndexEntry(id="C1:2024-01-15:chat",
                       name="chat.jsonl",
                       resource_type="discord/chat_jsonl",
                       vfs_name=FILE)))
    _run(
        index.put(
            f"{PREFIX}/{MEMBER_PATH}",
            IndexEntry(id="U1",
                       name="alice",
                       resource_type="discord/member",
                       vfs_name="alice.json")))
    _run(
        index.put(
            f"{PREFIX}/{GUILD}/members",
            IndexEntry(id="G1:members",
                       name="members",
                       resource_type="discord/virtual_dir")))
    _run(
        index.set_dir(f"{PREFIX}/{GUILD}/channels", [
            (CHANNEL,
             IndexEntry(id="C1",
                        name=CHANNEL,
                        resource_type="discord/channel",
                        vfs_name=CHANNEL)),
        ]))
    _run(
        index.set_dir(f"{PREFIX}/{CHANNEL_PATH}", [
            (DATE,
             IndexEntry(id="C1:2024-01-15",
                        name="2024-01-15",
                        resource_type="discord/history",
                        vfs_name=DATE)),
        ]))
    _run(
        index.set_dir(f"{PREFIX}/{DATE_DIR_PATH}", [
            (FILE,
             IndexEntry(id="C1:2024-01-15:chat",
                        name="chat.jsonl",
                        resource_type="discord/chat_jsonl",
                        vfs_name=FILE)),
        ]))
    _run(
        index.set_dir(f"{PREFIX}/{GUILD}/members", [
            ("alice.json",
             IndexEntry(id="U1",
                        name="alice",
                        resource_type="discord/member",
                        vfs_name="alice.json")),
        ]))
    return resource


def _make_ops(resource: DiscordResource) -> Ops:
    mount = OpsMount(
        prefix=f"{PREFIX}/",
        resource_type=resource.name,
        accessor=resource.accessor,
        index=resource.index,
        mode=MountMode.READ,
        ops=resource.ops_list(),
    )
    return Ops([mount])


@pytest.fixture
def resource():
    return _make_resource()


@pytest.fixture
def ops(resource):
    return _make_ops(resource)


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
    assert "alice.json" in names


# ── ops.stat ─────────────────────────────────────


def test_ops_stat_guild(ops):
    s = _run(ops.stat(f"{PREFIX}/{GUILD}"))
    assert s.type == FileType.DIRECTORY


def test_ops_stat_channel(ops):
    s = _run(ops.stat(f"{PREFIX}/{CHANNEL_PATH}"))
    assert s.type == FileType.DIRECTORY


def test_ops_stat_file(ops):
    s = _run(ops.stat(f"{PREFIX}/{FILE_PATH}"))
    assert s.type == FileType.TEXT
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
