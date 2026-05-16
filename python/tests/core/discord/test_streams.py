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

from mirage.core.discord.guilds import list_guilds_stream
from mirage.core.discord.history import (date_to_snowflake,
                                         stream_messages_for_day)
from mirage.core.discord.members import list_members_stream
from mirage.core.discord.search import search_guild_stream
from mirage.resource.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="t")


@pytest.mark.asyncio
async def test_list_guilds_stream_walks_pages(config):
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=[[{
                   "id": "G1"
               }, {
                   "id": "G2"
               }], [{
                   "id": "G3"
               }]]):
        collected = []
        async for page in list_guilds_stream(config, page_size=2):
            collected.append(page)
    assert collected == [[{"id": "G1"}, {"id": "G2"}], [{"id": "G3"}]]


@pytest.mark.asyncio
async def test_list_members_stream_walks_user_ids(config):
    page1 = [{"user": {"id": "U1"}}, {"user": {"id": "U2"}}]
    page2 = [{"user": {"id": "U3"}}]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=[page1, page2]) as mock:
        collected = []
        async for page in list_members_stream(config, "G1", page_size=2):
            collected.append(page)
    assert collected == [page1, page2]
    assert mock.call_args_list[1].kwargs["params"]["after"] == "U2"


@pytest.mark.asyncio
async def test_stream_messages_for_day_filters_by_date(config):
    before_int = int(date_to_snowflake("2024-01-15", end=True))
    in_range = [{"id": str(before_int - 1000), "content": "ok"}]
    out_of_range = [{"id": str(before_int + 1000), "content": "next-day"}]
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               return_value=in_range + out_of_range):
        pages = [
            p async for p in stream_messages_for_day(
                config, "C1", "2024-01-15", page_size=2)
        ]
    flat = [m for page in pages for m in page]
    assert all(int(m["id"]) <= before_int for m in flat)
    assert any(m["content"] == "ok" for m in flat)


@pytest.mark.asyncio
async def test_search_guild_stream_flattens_contexts(config):
    p1 = {
        "messages": [[{
            "id": "1"
        }], [{
            "id": "2"
        }]],
        "total_results": 30,
    }
    p2 = {"messages": [[{"id": "3"}]], "total_results": 30}
    with patch("mirage.core.discord.paginate.discord_get",
               new_callable=AsyncMock,
               side_effect=[p1, p2]):
        collected = []
        async for page in search_guild_stream(config, "G1", "x", max_pages=2):
            collected.append(page)
    flat = [m["id"] for page in collected for m in page]
    assert flat == ["1", "2", "3"]
