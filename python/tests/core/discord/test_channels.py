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

from mirage.core.discord.channels import list_channels
from mirage.core.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


@pytest.mark.asyncio
async def test_list_channels(config):
    mock_data = [
        {
            "id": "C001",
            "name": "general",
            "type": 0
        },
        {
            "id": "C002",
            "name": "announcements",
            "type": 5
        },
        {
            "id": "C003",
            "name": "forum",
            "type": 15
        },
        {
            "id": "C004",
            "name": "voice-chat",
            "type": 2
        },
    ]
    with patch(
            "mirage.core.discord.channels.discord_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await list_channels(config, "G001")

    assert len(result) == 3
    assert result[0]["name"] == "general"
    assert result[1]["name"] == "announcements"
    assert result[2]["name"] == "forum"
    mock_get.assert_called_once_with(config, "/guilds/G001/channels")


@pytest.mark.asyncio
async def test_list_channels_filters_voice(config):
    mock_data = [
        {
            "id": "C001",
            "name": "voice-chat",
            "type": 2
        },
        {
            "id": "C002",
            "name": "stage",
            "type": 13
        },
    ]
    with patch(
            "mirage.core.discord.channels.discord_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await list_channels(config, "G001")

    assert len(result) == 0
