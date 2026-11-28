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

from mirage.core.discord.channels import list_channels
from tests.fixtures.discord_guild import CHANNELS, GUILD


async def _with_channels(discord_guild, *rows: dict) -> None:
    # Discord's own channel list, with channels of kinds the unit world
    # does not hold.
    own = await discord_guild.run.call(
        "GET", f"/api/v10/guilds/{GUILD}/channels"
    )
    await discord_guild.run.answer_next("GET", CHANNELS, 200, [*own, *rows])


@pytest.mark.asyncio
async def test_list_channels(discord_guild):
    await _with_channels(
        discord_guild,
        {"id": "213", "name": "announcements", "type": 5},
        {"id": "214", "name": "forum", "type": 15},
        {"id": "215", "name": "voice-chat", "type": 2},
    )
    result = await list_channels(discord_guild.accessor(), GUILD)
    assert [c["name"] for c in result] == [
        "general",
        "random",
        "announcements",
        "forum",
    ]
    assert await discord_guild.run.requests() == [
        f"GET /api/v10/guilds/{GUILD}/channels"
    ]


@pytest.mark.asyncio
async def test_list_channels_filters_voice(discord_guild):
    await discord_guild.run.answer_next(
        "GET",
        CHANNELS,
        200,
        [
            {"id": "215", "name": "voice-chat", "type": 2},
            {"id": "216", "name": "stage", "type": 13},
        ],
    )
    assert await list_channels(discord_guild.accessor(), GUILD) == []
