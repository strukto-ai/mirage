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

from mirage.core.discord.threads import create_thread
from tests.fixtures.discord_guild import DAY, GENERAL, THREADS

FROM_MESSAGE = "/api/v10/channels/:channel_id/messages/:message_id/threads"


@pytest.mark.asyncio
async def test_create_thread_from_message(discord_guild):
    [hello, _] = await discord_guild.day(GENERAL, DAY)
    result = await create_thread(
        discord_guild.accessor(), GENERAL, "topic", message_id=hello["id"]
    )
    assert await discord_guild.run.bodies("POST", FROM_MESSAGE) == [
        {"name": "topic"}
    ]
    assert (result["name"], result["parent_id"]) == ("topic", GENERAL)


@pytest.mark.asyncio
async def test_create_thread_standalone(discord_guild):
    result = await create_thread(discord_guild.accessor(), GENERAL, "topic")
    assert await discord_guild.run.bodies("POST", THREADS) == [
        {"name": "topic", "type": 11}
    ]
    assert (result["type"], result["parent_id"]) == (11, GENERAL)
