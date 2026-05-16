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

from mirage.core.discord.members import list_members, search_members
from mirage.resource.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


@pytest.mark.asyncio
async def test_list_members(config):
    mock_data = [
        {
            "user": {
                "id": "U001",
                "username": "alice"
            }
        },
        {
            "user": {
                "id": "U002",
                "username": "bob"
            }
        },
    ]
    with patch(
            "mirage.core.discord.paginate.discord_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await list_members(config, "G001")

    assert len(result) == 2
    assert result[0]["user"]["username"] == "alice"
    mock_get.assert_called_once()
    args, kwargs = mock_get.call_args
    assert args[1] == "/guilds/G001/members"
    assert kwargs["params"]["after"] == "0"
    assert kwargs["params"]["limit"] == 1000


@pytest.mark.asyncio
async def test_search_members(config):
    mock_data = [
        {
            "user": {
                "id": "U001",
                "username": "alice"
            }
        },
    ]
    with patch(
            "mirage.core.discord.members.discord_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await search_members(config, "G001", "ali")

    assert len(result) == 1
    assert result[0]["user"]["username"] == "alice"
    mock_get.assert_called_once_with(
        config,
        "/guilds/G001/members/search",
        params={
            "query": "ali",
            "limit": 100
        },
    )
