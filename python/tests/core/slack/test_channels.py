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

from mirage.core.slack.channels import list_channels, list_dms
from mirage.resource.slack.config import SlackConfig


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.mark.asyncio
async def test_list_channels(config):
    mock_data = {
        "ok":
        True,
        "channels": [
            {
                "id": "C001",
                "name": "general"
            },
            {
                "id": "C002",
                "name": "random"
            },
        ],
        "response_metadata": {
            "next_cursor": ""
        },
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await list_channels(config)

    assert len(result) == 2
    assert result[0]["name"] == "general"
    assert result[1]["id"] == "C002"
    mock_get.assert_called_once()
    call_kwargs = mock_get.call_args
    assert call_kwargs.kwargs["params"]["types"] == \
        "public_channel,private_channel"


@pytest.mark.asyncio
async def test_list_channels_pagination(config):
    page1 = {
        "ok": True,
        "channels": [{
            "id": "C001",
            "name": "general"
        }],
        "response_metadata": {
            "next_cursor": "cursor_abc"
        },
    }
    page2 = {
        "ok": True,
        "channels": [{
            "id": "C002",
            "name": "random"
        }],
        "response_metadata": {
            "next_cursor": ""
        },
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            side_effect=[page1, page2],
    ) as mock_get:
        result = await list_channels(config)

    assert len(result) == 2
    assert mock_get.call_count == 2
    second_call = mock_get.call_args_list[1]
    assert second_call.kwargs["params"]["cursor"] == "cursor_abc"


@pytest.mark.asyncio
async def test_list_dms(config):
    mock_data = {
        "ok": True,
        "channels": [{
            "id": "D001",
            "user": "U001"
        }],
        "response_metadata": {
            "next_cursor": ""
        },
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ) as mock_get:
        result = await list_dms(config)

    assert len(result) == 1
    assert result[0]["id"] == "D001"
    call_kwargs = mock_get.call_args
    assert call_kwargs.kwargs["params"]["types"] == "im,mpim"
