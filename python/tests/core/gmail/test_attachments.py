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

import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from mirage.core.gmail.messages import _extract_attachments, get_attachment


def test_extract_attachments_none():
    payload = {"mimeType": "text/plain", "body": {"data": "test"}}
    assert _extract_attachments(payload) == []


def test_extract_attachments_single():
    payload = {
        "mimeType":
        "multipart/mixed",
        "parts": [
            {
                "mimeType": "text/plain",
                "body": {
                    "data": "text"
                }
            },
            {
                "filename": "report.pdf",
                "body": {
                    "attachmentId": "att1",
                    "size": 1024
                },
            },
        ],
    }
    result = _extract_attachments(payload)
    assert len(result) == 1
    assert result[0]["filename"] == "report.pdf"
    assert result[0]["attachment_id"] == "att1"
    assert result[0]["size"] == 1024


def test_extract_attachments_nested():
    payload = {
        "mimeType":
        "multipart/mixed",
        "parts": [{
            "mimeType":
            "multipart/alternative",
            "parts": [
                {
                    "filename": "image.png",
                    "body": {
                        "attachmentId": "att2",
                        "size": 2048
                    },
                },
            ],
        }],
    }
    result = _extract_attachments(payload)
    assert len(result) == 1
    assert result[0]["filename"] == "image.png"


@pytest.mark.asyncio
async def test_get_attachment():
    encoded = base64.urlsafe_b64encode(b"hello world").decode().rstrip("=")
    token_manager = SimpleNamespace(config=SimpleNamespace(api_base=None))
    with patch(
            "mirage.core.gmail.messages.google_get",
            new_callable=AsyncMock,
            return_value={"data": encoded},
    ):
        result = await get_attachment(token_manager, "msg1", "att1")
        assert result == b"hello world"
