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

import json

import pytest

from mirage.core.discord.history import (
    get_history_jsonl,
    list_messages_for_day,
    snowflake_at,
)
from mirage.core.time_range import TimeRange
from tests.fixtures.discord_guild import DAY, GENERAL, MESSAGES


@pytest.mark.asyncio
async def test_get_history_jsonl(discord_guild):
    # Discord answers newest first; the day's lines run oldest first.
    result = await get_history_jsonl(discord_guild.accessor(), GENERAL, DAY)
    lines = [json.loads(line) for line in result.decode().splitlines()]
    assert [m["content"] for m in lines] == ["hello", "files"]
    assert int(lines[0]["id"]) < int(lines[1]["id"])


@pytest.mark.asyncio
async def test_get_history_empty(discord_guild):
    result = await get_history_jsonl(
        discord_guild.accessor(), GENERAL, "2024-01-10"
    )
    assert result == b""


@pytest.mark.asyncio
async def test_messages_after_an_id_start_past_it(discord_guild):
    later = str(snowflake_at(1705320000) + 5)
    found = await list_messages_for_day(
        discord_guild.accessor(), GENERAL, DAY, TimeRange(), after=later
    )
    # 1705320000 is 2024-01-15 12:00, past both of the day's messages.
    assert found == []
    [params] = await discord_guild.run.params("GET", MESSAGES)
    assert params["after"] == later
