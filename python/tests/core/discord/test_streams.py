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

from mirage.core.discord.guilds import list_guilds_stream
from mirage.core.discord.history import snowflake_at, stream_messages_for_day
from mirage.core.discord.members import list_members_stream
from mirage.core.discord.search import search_guild_stream
from mirage.core.time_range import TimeRange
from tests.fixtures.discord_guild import ALICE, DAY, GENERAL, GUILD, MEMBERS


@pytest.mark.asyncio
async def test_list_guilds_stream_walks_pages(discord_guild):
    # The bot is in two more servers than the unit world's own.
    await discord_guild.run.execute(
        "INSERT INTO DiscordGuild (tenant, id, seq, idNum, name) VALUES "
        "('default', '222', 2, 222, 'Second'), "
        "('default', '333', 3, 333, 'Third')"
    )
    collected = [
        [g["id"] for g in page]
        async for page in list_guilds_stream(
            discord_guild.accessor(), page_size=2
        )
    ]
    assert collected == [[GUILD, "222"], ["333"]]


@pytest.mark.asyncio
async def test_list_members_stream_walks_user_ids(discord_guild):
    collected = [
        [m["user"]["id"] for m in page]
        async for page in list_members_stream(
            discord_guild.accessor(), GUILD, page_size=2
        )
    ]
    assert collected == [["311", "312"], ["911"]]
    asked = await discord_guild.run.params("GET", MEMBERS)
    assert asked[1]["after"] == "312"


@pytest.mark.asyncio
async def test_stream_messages_for_day_filters_by_date(discord_guild):
    # Two a page: the day's two, then the next day's morning, which is
    # left out.
    before_int = snowflake_at(
        datetime(2024, 1, 16, tzinfo=timezone.utc).timestamp()
    )
    pages = [
        p
        async for p in stream_messages_for_day(
            discord_guild.accessor(), GENERAL, DAY, TimeRange(), page_size=2
        )
    ]
    flat = [m for page in pages for m in page]
    assert all(int(m["id"]) < before_int for m in flat)
    assert sorted(m["content"] for m in flat) == ["files", "hello"]


@pytest.mark.asyncio
async def test_search_guild_stream_flattens_contexts(discord_guild):
    start = datetime(2024, 1, 20, tzinfo=timezone.utc)
    await discord_guild.add_messages(
        GENERAL,
        ALICE,
        [(start + timedelta(minutes=i), f"msg{i}") for i in range(30)],
    )
    collected = [
        page
        async for page in search_guild_stream(
            discord_guild.accessor(), GUILD, "msg", max_pages=2
        )
    ]
    # Each hit comes in a context of its own; the stream yields the hits.
    assert [len(page) for page in collected] == [25, 5]
    flat = [m["content"] for page in collected for m in page]
    assert sorted(flat) == sorted(f"msg{i}" for i in range(30))
