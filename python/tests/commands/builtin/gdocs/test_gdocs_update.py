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

from mirage.accessor.gdocs import GDocsAccessor
from mirage.commands.builtin.gdocs.gws_docs_documents_batchUpdate import \
    gws_docs_documents_batchUpdate
from mirage.core.google._client import TokenManager
from mirage.core.google.config import GoogleConfig


@pytest.fixture
def accessor():
    config = GoogleConfig(client_id="cid", refresh_token="rt")
    return GDocsAccessor(config=config, token_manager=TokenManager(config))


@pytest.mark.asyncio
async def test_batch_update_success(accessor):
    payload = json.dumps({
        "requests": [{
            "insertText": {
                "location": {
                    "index": 1
                },
                "text": "Hi",
            }
        }]
    })
    params = json.dumps({"documentId": "doc1"})
    api_response = {"documentId": "doc1", "replies": [{}]}
    with patch(
            "mirage.core.gdocs.update.google_post",
            new_callable=AsyncMock,
            return_value=api_response,
    ):
        fn = gws_docs_documents_batchUpdate._registered_commands[0].fn
        stream, io = await fn(
            accessor,
            [],
            params=params,
            json=payload,
        )
        chunks = []
        async for chunk in stream:
            chunks.append(chunk)
        result = json.loads(b"".join(chunks))
        assert result["documentId"] == "doc1"


@pytest.mark.asyncio
async def test_batch_update_missing_params(accessor):
    fn = gws_docs_documents_batchUpdate._registered_commands[0].fn
    with pytest.raises(ValueError, match="--params"):
        await fn(accessor, [])
