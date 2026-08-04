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

from mirage.core.email.config import EmailConfig
from mirage.core.email.send import forward_message, reply_message, send_message


@pytest.fixture
def config():
    return EmailConfig(
        imap_host="imap.test.com",
        smtp_host="smtp.test.com",
        smtp_port=587,
        username="user@test.com",
        password="pass",
    )


@pytest.mark.asyncio
async def test_send_message(config):
    with patch("mirage.core.email.send.aiosmtplib.send",
               new_callable=AsyncMock) as mock_send:
        result = await send_message(config, "bob@example.com", "Hello",
                                    "Hi there")
        assert result["status"] == "sent"
        assert result["to"] == "bob@example.com"
        assert result["subject"] == "Hello"
        mock_send.assert_called_once()


@pytest.mark.asyncio
async def test_reply_message(config):
    original = {
        "from": {
            "name": "Alice",
            "email": "alice@example.com"
        },
        "to": [{
            "name": "",
            "email": "user@test.com"
        }],
        "cc": [],
        "subject": "Hello",
        "message_id": "<abc123@example.com>",
        "references": [],
        "body_text": "Original text",
        "date": "Mon, 14 Apr 2026 10:30:00 +0000",
    }
    with patch("mirage.core.email.send.aiosmtplib.send",
               new_callable=AsyncMock) as mock_send:
        result = await reply_message(config, original, "Thanks!")
        assert result["status"] == "sent"
        assert result["to"] == "alice@example.com"
        assert result["subject"] == "Re: Hello"
        mock_send.assert_called_once()
        sent_msg = mock_send.call_args[0][0]
        assert sent_msg["In-Reply-To"] == "<abc123@example.com>"


@pytest.mark.asyncio
async def test_forward_message(config):
    original = {
        "from": {
            "name": "Alice",
            "email": "alice@example.com"
        },
        "subject": "Hello",
        "body_text": "Original text",
        "date": "Mon, 14 Apr 2026 10:30:00 +0000",
    }
    with patch("mirage.core.email.send.aiosmtplib.send",
               new_callable=AsyncMock) as mock_send:
        result = await forward_message(config, original, "charlie@example.com")
        assert result["status"] == "sent"
        assert result["to"] == "charlie@example.com"
        assert result["subject"] == "Fwd: Hello"
        mock_send.assert_called_once()
