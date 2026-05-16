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

from mirage.core.discord.history import get_history_jsonl
from mirage.resource.discord.config import DiscordConfig


@pytest.fixture
def config():
    return DiscordConfig(token="test-bot-token")


@pytest.mark.asyncio
async def test_get_history_jsonl(config):
    messages = [
        {
            "id": "200",
            "content": "second"
        },
        {
            "id": "100",
            "content": "first"
        },
    ]
    with patch(
            "mirage.core.discord.paginate.discord_get",
            new_callable=AsyncMock,
            return_value=messages,
    ):
        result = await get_history_jsonl(config, "C001", "2024-01-15")

    lines = result.decode().strip().split("\n")
    assert len(lines) == 2
    first = json.loads(lines[0])
    second = json.loads(lines[1])
    assert int(first["id"]) < int(second["id"])
    assert first["content"] == "first"
    assert second["content"] == "second"


@pytest.mark.asyncio
async def test_get_history_empty(config):
    with patch(
            "mirage.core.discord.paginate.discord_get",
            new_callable=AsyncMock,
            return_value=[],
    ):
        result = await get_history_jsonl(config, "C001", "2024-01-15")

    assert result == b""
