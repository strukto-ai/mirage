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

from mirage.core.discord.guilds import list_guilds
from mirage.resource.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


@pytest.mark.asyncio
async def test_list_guilds(config):
    mock_data = [
        {
            "id": "G001",
            "name": "My Server"
        },
        {
            "id": "G002",
            "name": "Another Server"
        },
    ]
    with patch(
            "mirage.core.discord.paginate.discord_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await list_guilds(config)

    assert len(result) == 2
    assert result[0]["name"] == "My Server"
    assert result[1]["id"] == "G002"
    mock_get.assert_called_once()
    args, kwargs = mock_get.call_args
    assert args[1] == "/users/@me/guilds"
    assert kwargs["params"]["after"] == "0"
    assert kwargs["params"]["limit"] == 200
