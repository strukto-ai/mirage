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

from mirage.core.slack._client import slack_get, slack_post
from mirage.resource.slack.config import SlackConfig


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.mark.asyncio
async def test_slack_get_success(config):
    mock_resp = AsyncMock()
    mock_resp.json = AsyncMock(return_value={
        "ok": True,
        "channels": [],
    })
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.slack._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        result = await slack_get(config,
                                 "conversations.list",
                                 params={"limit": 10})

    assert result["ok"] is True
    mock_session.get.assert_called_once()
    call_kwargs = mock_session.get.call_args
    assert "https://slack.com/api/conversations.list" in call_kwargs.args \
        or call_kwargs.args[0] == "https://slack.com/api/conversations.list"
    assert call_kwargs.kwargs["headers"]["Authorization"] == \
        "Bearer xoxb-test-token"


@pytest.mark.asyncio
async def test_slack_get_error(config):
    mock_resp = AsyncMock()
    mock_resp.json = AsyncMock(return_value={
        "ok": False,
        "error": "channel_not_found",
    })
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.slack._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        with pytest.raises(
                RuntimeError,
                match=r"\(conversations\.info\): channel_not_found"):
            await slack_get(config, "conversations.info")


@pytest.mark.asyncio
async def test_slack_get_missing_scope_surfaces_scopes(config):
    mock_resp = AsyncMock()
    mock_resp.json = AsyncMock(
        return_value={
            "ok": False,
            "error": "missing_scope",
            "needed": "im:read,mpim:read",
            "provided": "channels:read,users:read",
        })
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.slack._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        with pytest.raises(
                RuntimeError,
                match=(r"\(conversations\.list\): missing_scope "
                       r"\(needed: im:read,mpim:read; "
                       r"provided: channels:read,users:read\)"),
        ):
            await slack_get(config, "conversations.list")


@pytest.mark.asyncio
async def test_slack_get_missing_scope_no_needed_falls_back(config):
    mock_resp = AsyncMock()
    mock_resp.json = AsyncMock(return_value={
        "ok": False,
        "error": "missing_scope",
    })
    mock_session = AsyncMock()
    mock_session.get = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.slack._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        with pytest.raises(RuntimeError) as ei:
            await slack_get(config, "conversations.list")
        assert str(ei.value).endswith(
            "Slack API error (conversations.list): missing_scope")


@pytest.mark.asyncio
async def test_slack_post_success(config):
    mock_resp = AsyncMock()
    mock_resp.json = AsyncMock(return_value={
        "ok": True,
        "ts": "1234567890.123456",
    })
    mock_session = AsyncMock()
    mock_session.post = MagicMock(return_value=AsyncMock(
        __aenter__=AsyncMock(return_value=mock_resp),
        __aexit__=AsyncMock(return_value=False),
    ))

    with patch("mirage.core.slack._client.aiohttp.ClientSession") as mock_cs:
        mock_cs.return_value.__aenter__ = AsyncMock(return_value=mock_session)
        mock_cs.return_value.__aexit__ = AsyncMock(return_value=False)

        result = await slack_post(config,
                                  "chat.postMessage",
                                  body={
                                      "channel": "C123",
                                      "text": "hello",
                                  })

    assert result["ok"] is True
    assert result["ts"] == "1234567890.123456"
    mock_session.post.assert_called_once()
    call_kwargs = mock_session.post.call_args
    assert call_kwargs.args[0] == "https://slack.com/api/chat.postMessage"
