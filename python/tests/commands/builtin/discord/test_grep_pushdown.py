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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.commands.builtin.discord.grep import grep
from mirage.commands.builtin.discord.rg import rg
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _concrete_paths(n: int = 7):
    paths = []
    for d in range(1, n + 1):
        original = (
            f"/discord/myguild/channels/general/2026-01-{d:02d}/chat.jsonl")
        paths.append(
            PathSpec(
                resource_path=mount_key(original, "/discord"),
                virtual=original,
                directory=original,
            ))
    return paths


def _fake_index(channel_id: str = "ch_456", guild_id: str = "g_123"):
    idx = AsyncMock()

    async def _get(virtual_key):
        result = AsyncMock()
        if virtual_key.endswith("/myguild/channels/general"):
            result.entry = type("E", (), {"id": channel_id})
        elif virtual_key.endswith("/myguild"):
            result.entry = type("E", (), {"id": guild_id})
        else:
            result.entry = None
        return result

    idx.get.side_effect = _get
    return idx


@pytest.mark.asyncio
async def test_discord_grep_with_many_concrete_paths_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_msgs = [{
        "content": "hello world",
        "channel_id": "ch_456",
        "author": {
            "username": "alice"
        },
        "timestamp": "2026-01-15T12:34:56.000000+00:00",
        "id": "1"
    }]
    fake_channels = [{"id": "ch_456", "name": "general"}]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=fake_msgs),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.list_channels",
            new=AsyncMock(return_value=fake_channels),
    ):
        out, io = await grep(accessor,
                             _concrete_paths(7),
                             "hello",
                             index=_fake_index())
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello" in out
    assert out.endswith(b"\n")
    assert (b"/discord/myguild/channels/general__ch_456/"
            b"2026-01-15/chat.jsonl:") in out


@pytest.mark.asyncio
async def test_discord_grep_falls_back_when_native_raises():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(resource_path=mount_key(
            "/discord/myguild/channels/general/*.jsonl", "/discord"),
                 virtual="/discord/myguild/channels/general/*.jsonl",
                 directory="/discord/myguild/channels/general/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(side_effect=RuntimeError("rate limited")),
    ), patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.grep._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.TEXT)),
    ):
        out, io = await grep(accessor, paths, "hello", index=_fake_index())
    assert fake_resolve.await_count == 1
    assert io.exit_code in (0, 1)


@pytest.mark.asyncio
async def test_discord_grep_native_empty_does_not_trigger_fallback():
    """search_guild returning [] is a legit no-match — don't double-scan."""
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.list_channels",
            new=AsyncMock(return_value=[]),
    ), patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ) as fake_read:
        out, io = await grep(accessor,
                             _concrete_paths(7),
                             "missing",
                             index=_fake_index())
    assert fake_search.await_count == 1
    assert fake_read.await_count == 0
    assert io.exit_code == 1
    assert out == b""


@pytest.mark.asyncio
async def test_discord_grep_multi_pattern_skips_native_search():
    """grep -e a -e b must bypass the native search push-down.

    The push-down passes a single newline-joined pattern to the native
    search, which treats it as one literal and matches nothing. Multiple
    -e patterns must fall through to the generic grep instead.
    """
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(resource_path=mount_key(
            "/discord/myguild/channels/general/*.jsonl", "/discord"),
                 virtual="/discord/myguild/channels/general/*.jsonl",
                 directory="/discord/myguild/channels/general/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.grep.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.grep.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.grep.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.grep._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.TEXT)),
    ):
        _, io = await grep(accessor,
                           paths,
                           e=["ada", "ben"],
                           index=_fake_index())
    assert fake_search.await_count == 0
    assert fake_resolve.await_count == 1


@pytest.mark.asyncio
async def test_discord_rg_with_many_concrete_paths_uses_native_search():
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    fake_msgs = [{
        "content": "hello rg",
        "channel_id": "ch_456",
        "author": {
            "username": "bob"
        },
        "timestamp": "2026-01-15T08:00:00.000000+00:00",
        "id": "2"
    }]
    fake_channels = [{"id": "ch_456", "name": "general"}]
    with patch(
            "mirage.commands.builtin.discord.rg.search_guild",
            new=AsyncMock(return_value=fake_msgs),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.rg.list_channels",
            new=AsyncMock(return_value=fake_channels),
    ):
        out, io = await rg(accessor,
                           _concrete_paths(7),
                           "hello",
                           index=_fake_index())
    assert fake_search.await_count == 1
    assert io.exit_code == 0
    assert b"hello" in out
    assert out.endswith(b"\n")
    assert (b"/discord/myguild/channels/general__ch_456/"
            b"2026-01-15/chat.jsonl:") in out


@pytest.mark.asyncio
async def test_discord_rg_multi_pattern_skips_native_search():
    """rg -e a -e b must bypass the native search push-down.

    Like grep, the push-down passes a single newline-joined pattern to the
    native search, which matches nothing. Multiple -e patterns must fall
    through to the generic rg instead.
    """
    accessor = AsyncMock()
    accessor.config = AsyncMock()
    paths = [
        PathSpec(resource_path=mount_key(
            "/discord/myguild/channels/general/*.jsonl", "/discord"),
                 virtual="/discord/myguild/channels/general/*.jsonl",
                 directory="/discord/myguild/channels/general/",
                 pattern="*.jsonl"),
    ]
    with patch(
            "mirage.commands.builtin.discord.rg.search_guild",
            new=AsyncMock(return_value=[]),
    ) as fake_search, patch(
            "mirage.commands.builtin.discord.rg.resolve_glob",
            new=AsyncMock(return_value=paths),
    ) as fake_resolve, patch(
            "mirage.commands.builtin.discord.rg.discord_read",
            new=AsyncMock(return_value=b""),
    ), patch(
            "mirage.commands.builtin.discord.rg._stat",
            new=AsyncMock(return_value=FileStat(name="2026-04-10.jsonl",
                                                type=FileType.TEXT)),
    ):
        _, io = await rg(accessor,
                         paths,
                         e=["ada", "ben"],
                         index=_fake_index())
    assert fake_search.await_count == 0
    assert fake_resolve.await_count == 1
