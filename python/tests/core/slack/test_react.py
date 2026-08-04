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
from mirage.core.slack.react import add_reaction, get_reactions

CONFIG = SlackConfig(token="xoxb-test")


@pytest.mark.asyncio
async def test_add_reaction_posts_reactions_add():
    with patch("mirage.core.slack.react.slack_post",
               new_callable=AsyncMock,
               return_value={"ok": True}) as post:
        await add_reaction(CONFIG, "C001", "111.222", "shipit")
    post.assert_awaited_once_with(CONFIG, "reactions.add", {
        "channel": "C001",
        "timestamp": "111.222",
        "name": "shipit",
    })


@pytest.mark.asyncio
async def test_get_reactions_returns_the_message_item():
    message = {"ts": "111.222", "reactions": [{"name": "shipit", "count": 2}]}
    with patch("mirage.core.slack.react.slack_get",
               new_callable=AsyncMock,
               return_value={
                   "ok": True,
                   "message": message,
               }) as get:
        result = await get_reactions(CONFIG, "C001", "111.222")
    get.assert_awaited_once_with(CONFIG, "reactions.get", {
        "channel": "C001",
        "timestamp": "111.222",
    })
    assert result == message
