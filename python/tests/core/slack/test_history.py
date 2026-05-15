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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.slack.history import get_history_jsonl
from mirage.resource.slack.config import SlackConfig


@pytest.fixture
def config():
    return SlackConfig(token="xoxb-test-token")


@pytest.mark.asyncio
async def test_get_history_jsonl(config):
    mock_data = {
        "ok":
        True,
        "messages": [
            {
                "text": "second",
                "ts": "1700000002.000000"
            },
            {
                "text": "first",
                "ts": "1700000001.000000"
            },
        ],
        "has_more":
        False,
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await get_history_jsonl(config, "C001", "2023-11-14")

    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert first["text"] == "first"
    assert second["text"] == "second"
    assert float(first["ts"]) < float(second["ts"])


@pytest.mark.asyncio
async def test_get_history_empty(config):
    mock_data = {
        "ok": True,
        "messages": [],
        "has_more": False,
    }
    with patch(
            "mirage.core.slack.paginate.slack_get",
            new_callable=AsyncMock,
            return_value=mock_data,
    ):
        result = await get_history_jsonl(config, "C001", "2023-11-14")

    assert result == b""
