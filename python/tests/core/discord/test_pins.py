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
from aioresponses import aioresponses

from mirage.accessor.discord import DiscordAccessor
from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.pins import list_pins

PINS = "https://discord.com/api/v10/channels/c1/messages/pins"


@pytest.mark.asyncio
async def test_list_pins_pages_back_from_the_oldest_pin_seen():
    with aioresponses() as m:
        m.get(
            f"{PINS}?limit=50",
            payload={"items": [{"pinned_at": "t2"}], "has_more": True},
        )
        m.get(
            f"{PINS}?before=t2&limit=50",
            payload={"items": [{"pinned_at": "t1"}], "has_more": False},
        )
        async with DiscordAccessor(DiscordConfig(token="t")) as accessor:
            pins = await list_pins(accessor, "c1")

    assert [pin["pinned_at"] for pin in pins] == ["t2", "t1"]
