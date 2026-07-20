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

from mirage.accessor.gmail import GmailAccessor
from mirage.commands.builtin.gmail.gws_gmail_read import gws_gmail_read
from mirage.commands.builtin.gmail.gws_gmail_send import gws_gmail_send
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig


@pytest.fixture
def accessor():
    config = GoogleConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )
    tm = TokenManager(config)
    tm._access_token = "fake-token"
    tm._expires_at = 9999999999
    return GmailAccessor(config=config, token_manager=tm)


@pytest.mark.asyncio
async def test_gws_gmail_send(accessor):
    with patch(
            "mirage.commands.builtin.gmail.gws_gmail_send.send_message",
            new_callable=AsyncMock,
            return_value={"id": "sent1"},
    ):
        stream, io = await gws_gmail_send(
            accessor,
            [],
            to="bob@example.com",
            subject="Hello",
            body="Hi Bob!",
        )
        chunks = []
        async for chunk in stream:
            chunks.append(chunk)
        result = json.loads(b"".join(chunks))
        assert result["id"] == "sent1"


@pytest.mark.asyncio
async def test_gws_gmail_send_missing_to(accessor):
    with pytest.raises(ValueError, match="--to is required"):
        await gws_gmail_send(
            accessor,
            [],
            subject="Hello",
            body="Hi!",
        )


@pytest.mark.asyncio
async def test_gws_gmail_read(accessor):
    processed = {"id": "msg1", "subject": "Test", "body_text": "Hello!"}
    with patch(
            "mirage.commands.builtin.gmail"
            ".gws_gmail_read"
            ".get_message_processed",
            new_callable=AsyncMock,
            return_value=processed,
    ):
        stream, io = await gws_gmail_read(
            accessor,
            [],
            id="msg1",
        )
        chunks = []
        async for chunk in stream:
            chunks.append(chunk)
        result = json.loads(b"".join(chunks))
        assert result["subject"] == "Test"


@pytest.mark.asyncio
async def test_gws_gmail_read_missing_id(accessor):
    with pytest.raises(ValueError, match="--id is required"):
        await gws_gmail_read(accessor, [])
