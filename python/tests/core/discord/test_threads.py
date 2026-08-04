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

from mirage.core.discord.config import DiscordConfig
from mirage.core.discord.threads import create_thread

CONFIG = DiscordConfig(token="bot-token")


@pytest.mark.asyncio
async def test_create_thread_from_message():
    with patch("mirage.core.discord.threads.discord_post",
               new_callable=AsyncMock,
               return_value={"id": "T1"}) as post:
        result = await create_thread(CONFIG, "C1", "topic", message_id="M1")
    post.assert_awaited_once_with(CONFIG, "/channels/C1/messages/M1/threads",
                                  {"name": "topic"})
    assert result == {"id": "T1"}


@pytest.mark.asyncio
async def test_create_thread_standalone():
    with patch("mirage.core.discord.threads.discord_post",
               new_callable=AsyncMock,
               return_value={"id": "T2"}) as post:
        await create_thread(CONFIG, "C1", "topic")
    post.assert_awaited_once_with(CONFIG, "/channels/C1/threads", {
        "name": "topic",
        "type": 11
    })
