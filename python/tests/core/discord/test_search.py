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

from datetime import datetime, timedelta, timezone

import pytest

from mirage.core.discord.search import search_guild
from tests.fixtures.discord_guild import ALICE, GENERAL, GUILD, SEARCH

pytestmark = pytest.mark.asyncio


def _contents(results) -> list[str]:
    return [m["content"] for m in results]


async def _thirty(guild) -> None:
    # More hits than one search page holds.
    start = datetime(2024, 1, 20, tzinfo=timezone.utc)
    await guild.add_messages(
        GENERAL,
        ALICE,
        [(start + timedelta(minutes=i), f"msg{i}") for i in range(30)],
    )


async def test_search_returns_messages(discord_guild):
    results = await search_guild(discord_guild.accessor(), GUILD, "hello")
    assert _contents(results) == ["hello"]


async def test_search_with_channel_filter(discord_guild):
    # random's chatter matches too, outside the channel asked for.
    results = await search_guild(
        discord_guild.accessor(), GUILD, "o", channel_id=GENERAL
    )
    assert _contents(results) == ["hello", "morning"]
    [params] = await discord_guild.run.params("GET", SEARCH)
    assert (params["channel_id"], params["content"]) == (GENERAL, "o")


async def test_search_empty_results(discord_guild):
    assert (
        await search_guild(discord_guild.accessor(), GUILD, "nonexistent")
        == []
    )


async def test_search_sorted_oldest_first(discord_guild):
    # random's chatter on 2024-01-14, then general's hello and morning.
    results = await search_guild(discord_guild.accessor(), GUILD, "o")
    assert _contents(results) == ["random chatter", "hello", "morning"]


async def test_search_respects_limit(discord_guild):
    await _thirty(discord_guild)
    results = await search_guild(
        discord_guild.accessor(), GUILD, "msg", limit=3
    )
    assert len(results) == 3


async def test_search_paginates(discord_guild):
    await _thirty(discord_guild)
    results = await search_guild(
        discord_guild.accessor(), GUILD, "msg", limit=100
    )
    assert sorted(_contents(results)) == sorted(f"msg{i}" for i in range(30))
    assert await discord_guild.count(SEARCH) == 2
