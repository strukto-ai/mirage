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

import pytest

from mirage.core.discord.members import list_members, search_members
from tests.fixtures.discord_guild import GUILD, MEMBER_SEARCH, MEMBERS


@pytest.mark.asyncio
async def test_list_members(discord_guild):
    result = await list_members(discord_guild.accessor(), GUILD)
    assert [m["user"]["username"] for m in result] == [
        "alice",
        "bob",
        "mirage-bot",
    ]
    [params] = await discord_guild.run.params("GET", MEMBERS)
    assert (params["after"], params["limit"]) == ("0", "1000")


@pytest.mark.asyncio
async def test_search_members(discord_guild):
    result = await search_members(discord_guild.accessor(), GUILD, "ali")
    assert [m["user"]["username"] for m in result] == ["alice"]
    assert await discord_guild.run.params("GET", MEMBER_SEARCH) == [
        {"query": "ali", "limit": "100"}
    ]


# A walk's limit stops the paging at the page that brings that many.
@pytest.mark.asyncio
async def test_list_members_pages_no_further_than_stop_at(discord_guild):
    result = await list_members(
        discord_guild.accessor(), GUILD, page_size=1, stop_at=1
    )
    assert [m["user"]["username"] for m in result] == ["alice"]
    assert await discord_guild.count(MEMBERS) == 1
