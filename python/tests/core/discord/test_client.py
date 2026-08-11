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

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.core.discord._client import discord_get, discord_post
from mirage.core.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


@pytest.mark.asyncio
async def test_discord_get_success(config):
    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.json = AsyncMock(return_value=[
        {
            "id": "123",
            "name": "general"
        },
    ])
    mock_resp.raise_for_status = MagicMock()
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.discord._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        result = await discord_get(config, "/guilds/123/channels")

    assert result == [{"id": "123", "name": "general"}]
    mock_session.get.assert_called_once()
    call_kwargs = mock_session.get.call_args
    assert call_kwargs.args[0] == \
        "https://discord.com/api/v10/guilds/123/channels"
    assert call_kwargs.kwargs["headers"]["Authorization"] == \
        "Bot test-bot-token"


@pytest.mark.asyncio
async def test_discord_get_rate_limited(config):
    mock_resp = AsyncMock()
    mock_resp.status = 429
    mock_resp.json = AsyncMock(return_value={
        "retry_after": 5,
    })
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.discord._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        with pytest.raises(RuntimeError, match="Rate limited"):
            await discord_get(config, "/users/@me/guilds")


@pytest.mark.asyncio
async def test_discord_post_success(config):
    mock_resp = AsyncMock()
    mock_resp.status = 200
    mock_resp.json = AsyncMock(return_value={
        "id": "msg1",
        "content": "hello",
    })
    mock_resp.raise_for_status = MagicMock()
    mock_session = AsyncMock()
    mock_session.post = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.discord._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        result = await discord_post(config,
                                    "/channels/C001/messages",
                                    body={"content": "hello"})

    assert result["id"] == "msg1"
    mock_session.post.assert_called_once()
    call_kwargs = mock_session.post.call_args
    assert call_kwargs.args[0] == \
        "https://discord.com/api/v10/channels/C001/messages"
