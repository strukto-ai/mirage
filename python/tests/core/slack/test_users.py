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

from mirage.core.slack.users import get_user_profile, list_users, search_users
from mirage.resource.slack.config import SlackConfig


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.mark.asyncio
async def test_list_users(config):
    mock_data = {
        "ok":
        True,
        "members": [
            {
                "id": "U001",
                "name": "alice",
                "deleted": False,
                "is_bot": False
            },
            {
                "id": "U002",
                "name": "bot-helper",
                "deleted": False,
                "is_bot": True
            },
            {
                "id": "U003",
                "name": "gone",
                "deleted": True,
                "is_bot": False
            },
            {
                "id": "USLACKBOT",
                "name": "slackbot",
                "deleted": False,
                "is_bot": False
            },
            {
                "id": "U004",
                "name": "bob",
                "deleted": False,
                "is_bot": False
            },
        ],
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await list_users(config)

    assert len(result) == 2
    names = [u["name"] for u in result]
    assert "alice" in names
    assert "bob" in names
    assert "bot-helper" not in names
    assert "gone" not in names
    assert "slackbot" not in names


@pytest.mark.asyncio
async def test_search_users(config):
    mock_data = {
        "ok":
        True,
        "members": [
            {
                "id": "U001",
                "name": "alice",
                "real_name": "Alice Smith",
                "deleted": False,
                "is_bot": False,
                "profile": {
                    "email": "alice@example.com"
                }
            },
            {
                "id": "U002",
                "name": "bob",
                "real_name": "Bob Jones",
                "deleted": False,
                "is_bot": False,
                "profile": {
                    "email": "bob@example.com"
                }
            },
        ],
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await search_users(config, "alice")

    assert len(result) == 1
    assert result[0]["name"] == "alice"


@pytest.mark.asyncio
async def test_search_users_by_email(config):
    mock_data = {
        "ok":
        True,
        "members": [
            {
                "id": "U001",
                "name": "alice",
                "real_name": "Alice Smith",
                "deleted": False,
                "is_bot": False,
                "profile": {
                    "email": "alice@example.com"
                }
            },
            {
                "id": "U002",
                "name": "bob",
                "real_name": "Bob Jones",
                "deleted": False,
                "is_bot": False,
                "profile": {
                    "email": "bob@example.com"
                }
            },
        ],
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await search_users(config, "bob@example")

    assert len(result) == 1
    assert result[0]["name"] == "bob"


@pytest.mark.asyncio
async def test_get_user_profile(config):
    mock_data = {
        "ok": True,
        "user": {
            "id": "U001",
            "name": "alice",
            "real_name": "Alice Smith",
            "profile": {
                "email": "alice@example.com"
            },
        },
    }
    with patch(
            "mirage.core.slack.users.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await get_user_profile(config, "U001")

    assert result["id"] == "U001"
    assert result["name"] == "alice"
