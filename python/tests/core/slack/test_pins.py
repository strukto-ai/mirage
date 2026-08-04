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

from mirage.core.slack.config import SlackConfig
from mirage.core.slack.pins import list_pins, pin_message, unpin_message

CONFIG = SlackConfig(token="xoxb-test")


@pytest.mark.asyncio
async def test_pin_message_posts_pins_add():
    with patch("mirage.core.slack.pins.slack_post",
               new_callable=AsyncMock,
               return_value={"ok": True}) as post:
        result = await pin_message(CONFIG, "C001", "111.222")
    post.assert_awaited_once_with(CONFIG, "pins.add", {
        "channel": "C001",
        "timestamp": "111.222",
    })
    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_unpin_message_posts_pins_remove():
    with patch("mirage.core.slack.pins.slack_post",
               new_callable=AsyncMock,
               return_value={"ok": True}) as post:
        await unpin_message(CONFIG, "C001", "111.222")
    post.assert_awaited_once_with(CONFIG, "pins.remove", {
        "channel": "C001",
        "timestamp": "111.222",
    })


@pytest.mark.asyncio
async def test_list_pins_returns_items():
    with patch("mirage.core.slack.pins.slack_get",
               new_callable=AsyncMock,
               return_value={
                   "ok": True,
                   "items": [{
                       "type": "message"
                   }],
               }) as get:
        items = await list_pins(CONFIG, "C001")
    get.assert_awaited_once_with(CONFIG, "pins.list", {"channel": "C001"})
    assert items == [{"type": "message"}]


@pytest.mark.asyncio
async def test_list_pins_tolerates_missing_items():
    with patch("mirage.core.slack.pins.slack_get",
               new_callable=AsyncMock,
               return_value={"ok": True}):
        assert await list_pins(CONFIG, "C001") == []
