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
from mirage.core.slack.emoji import list_emoji

CONFIG = SlackConfig(token="xoxb-test")


@pytest.mark.asyncio
async def test_list_emoji_returns_mapping():
    with patch("mirage.core.slack.emoji.slack_get",
               new_callable=AsyncMock,
               return_value={
                   "ok": True,
                   "emoji": {
                       "shipit": "https://emoji/shipit.png"
                   },
               }) as get:
        emoji = await list_emoji(CONFIG)
    get.assert_awaited_once_with(CONFIG, "emoji.list")
    assert emoji == {"shipit": "https://emoji/shipit.png"}


@pytest.mark.asyncio
async def test_list_emoji_tolerates_missing_key():
    with patch("mirage.core.slack.emoji.slack_get",
               new_callable=AsyncMock,
               return_value={"ok": True}):
        assert await list_emoji(CONFIG) == {}
