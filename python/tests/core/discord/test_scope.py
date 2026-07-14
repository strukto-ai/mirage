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
from unittest.mock import AsyncMock

import pytest

from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.discord.scope import coalesce_scopes, detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _run(coro):
    return asyncio.run(coro)


def _gs(path: str,
        prefix: str = "",
        pattern: str | None = None,
        resolved: bool = True) -> PathSpec:
    return PathSpec(
        resource_path=mount_key(path, prefix),
        virtual=path,
        directory=path.rsplit("/", 1)[0] + "/" if "/" in path else "/",
        pattern=pattern,
        resolved=resolved,
    )


@pytest.fixture
def index():
    idx = RAMIndexCacheStore(ttl=600)
    _run(
        idx.put(
            "/discord/TestGuild",
            IndexEntry(id="G1",
                       name="TestGuild",
                       resource_type="discord/guild")))
    _run(
        idx.put(
            "/discord/TestGuild/channels/general",
            IndexEntry(id="C1",
                       name="general",
                       resource_type="discord/channel")))
    return idx


# ── root ──────────────────────────────────────


def test_root_empty():
    scope = _run(
        detect_scope(PathSpec.from_str_path("/"), RAMIndexCacheStore()))
    assert scope.level == "root"


def test_root_prefix():
    scope = _run(
        detect_scope(_gs("/discord/", prefix="/discord"),
                     RAMIndexCacheStore()))
    assert scope.level == "root"


# ── guild ─────────────────────────────────────


def test_guild(index):
    scope = _run(
        detect_scope(_gs("/discord/TestGuild", prefix="/discord"), index))
    assert scope.level == "guild"
    assert scope.guild_id == "G1"


def test_guild_channels(index):
    scope = _run(
        detect_scope(_gs("/discord/TestGuild/channels", prefix="/discord"),
                     index))
    assert scope.level == "guild"
    assert scope.guild_id == "G1"


def test_guild_members(index):
    scope = _run(
        detect_scope(_gs("/discord/TestGuild/members", prefix="/discord"),
                     index))
    assert scope.level == "guild"
    assert scope.guild_id == "G1"


# ── channel ───────────────────────────────────


def test_channel(index):
    scope = _run(
        detect_scope(
            _gs("/discord/TestGuild/channels/general", prefix="/discord"),
            index))
    assert scope.level == "channel"
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"


# ── date / messages / files ────────────────────


def test_date_dir(index):
    scope = _run(
        detect_scope(
            _gs("/discord/TestGuild/channels/general/2024-04-10",
                prefix="/discord"), index))
    assert scope.level == "date"
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2024-04-10"


def test_messages_file(index):
    scope = _run(
        detect_scope(
            _gs("/discord/TestGuild/channels/general/2024-04-10/chat.jsonl",
                prefix="/discord"), index))
    assert scope.level == "messages"
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2024-04-10"


def test_files_dir(index):
    scope = _run(
        detect_scope(
            _gs("/discord/TestGuild/channels/general/2024-04-10/files",
                prefix="/discord"), index))
    assert scope.level == "files"
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2024-04-10"


def test_file_blob(index):
    scope = _run(
        detect_scope(
            _gs(
                "/discord/TestGuild/channels/general/2024-04-10/files/"
                "img__A1.png",
                prefix="/discord"), index))
    assert scope.level == "file_blob"
    assert scope.channel_id == "C1"
    assert scope.date_str == "2024-04-10"


# ── PathSpec ─────────────────────────────────


def test_glob_jsonl_in_channel(index):
    gs = PathSpec(
        resource_path=mount_key("/discord/TestGuild/channels/general/*.jsonl",
                                "/discord"),
        virtual="/discord/TestGuild/channels/general/*.jsonl",
        directory="/discord/TestGuild/channels/general/",
        pattern="*.jsonl",
        resolved=False,
    )
    scope = _run(detect_scope(gs, index))
    assert scope.level == "channel"
    assert scope.guild_id == "G1"
    assert scope.channel_id == "C1"


def test_glob_specific_date(index):
    gs = PathSpec(
        resource_path=mount_key(
            "/discord/TestGuild/channels/general/2024-04-*.jsonl", "/discord"),
        virtual="/discord/TestGuild/channels/general/2024-04-*.jsonl",
        directory="/discord/TestGuild/channels/general/",
        pattern="2024-04-*.jsonl",
        resolved=False,
    )
    scope = _run(detect_scope(gs, index))
    assert scope.level == "channel"
    assert scope.channel_id == "C1"


def test_glob_non_jsonl():
    gs = PathSpec(
        resource_path="discord/TestGuild/members/*.json",
        virtual="/discord/TestGuild/members/*.json",
        directory="/discord/TestGuild/members/",
        pattern="*.json",
        resolved=False,
    )
    scope = _run(detect_scope(gs, RAMIndexCacheStore()))
    assert scope.level != "channel"


def _spec(path: str, prefix: str = "/discord") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path)


@pytest.fixture
def fake_index():
    idx = AsyncMock()

    async def _get(virtual_key):
        result = AsyncMock()
        if virtual_key.endswith("/myguild/channels/general"):
            result.entry = type("E", (), {"id": "ch_456"})
        elif virtual_key.endswith("/myguild"):
            result.entry = type("E", (), {"id": "g_123"})
        else:
            result.entry = None
        return result

    idx.get.side_effect = _get
    return idx


@pytest.mark.asyncio
async def test_coalesce_concrete_jsonl_paths_same_channel(fake_index):
    paths = [
        _spec(f"/discord/myguild/channels/general/2026-01-{d:02d}/chat.jsonl")
        for d in range(1, 8)
    ]
    scope = await coalesce_scopes(paths, fake_index)
    assert scope is not None
    assert scope.level == "channel"
    assert scope.guild_id == "g_123"
    assert scope.channel_id == "ch_456"


@pytest.mark.asyncio
async def test_coalesce_returns_none_for_mixed_channels(fake_index):
    paths = [
        _spec("/discord/myguild/channels/general/2026-01-01/chat.jsonl"),
        _spec("/discord/myguild/channels/random/2026-01-01/chat.jsonl"),
    ]
    assert await coalesce_scopes(paths, fake_index) is None


@pytest.mark.asyncio
async def test_coalesce_empty_list_returns_none(fake_index):
    assert await coalesce_scopes([], fake_index) is None
