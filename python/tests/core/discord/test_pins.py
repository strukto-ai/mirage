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

from mirage.core.discord.pins import list_pins
from tests.fixtures.discord_guild import DAY, GENERAL, PINS

PIN_ONE = "/api/v10/channels/{channel}/messages/pins/{message}"


@pytest.mark.asyncio
async def test_list_pins_pages_back_from_the_oldest_pin_seen(discord_guild):
    hello, files = await discord_guild.day(GENERAL, DAY)
    for message in (hello, files):
        await discord_guild.run.call(
            "PUT", PIN_ONE.format(channel=GENERAL, message=message["id"])
        )
    # Discord's own first page holds the newer pin and says there is more.
    own = await discord_guild.run.call(
        "GET",
        f"/api/v10/channels/{GENERAL}/messages/pins",
        params={"limit": "50"},
    )
    newest = own["items"][0]
    await discord_guild.run.answer_next(
        "GET", PINS, 200, {"items": [newest], "has_more": True}
    )
    pins = await list_pins(discord_guild.accessor(), GENERAL)
    assert [pin["message"]["content"] for pin in pins] == ["files", "hello"]
    first, second = await discord_guild.run.params("GET", PINS)
    assert "before" not in first
    assert second["before"] == newest["pinned_at"]
