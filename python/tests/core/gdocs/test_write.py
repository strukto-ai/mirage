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

from mirage.core.gdocs.client import TokenManager
from mirage.core.gdocs.write import append_text
from mirage.vfs.gdocs.config import GDocsConfig


@pytest.fixture
def token_manager():
    config = GDocsConfig(
        client_id="test-id",
        client_secret="test-secret",
        refresh_token="test-refresh",
    )
    mgr = TokenManager(config)
    mgr._access_token = "fake-token"
    mgr._expires_at = 9999999999
    return mgr


def _location(mock_post) -> dict:
    payload = mock_post.call_args.args[2]
    return payload["requests"][0]["insertText"]["endOfSegmentLocation"]


@pytest.mark.asyncio
async def test_append_text_without_a_tab_names_none(token_manager):
    # No tabId is Google's "first tab", so the request must not invent
    # one: an empty string is a real tab id slot, not an absent one.
    with patch("mirage.core.gdocs.write.google_post",
               new_callable=AsyncMock,
               return_value={"documentId": "d1"}) as mock_post:
        await append_text(token_manager, "d1", "hello")
        assert _location(mock_post) == {"segmentId": ""}


@pytest.mark.asyncio
async def test_append_text_targets_the_named_tab(token_manager):
    with patch("mirage.core.gdocs.write.google_post",
               new_callable=AsyncMock,
               return_value={"documentId": "d1"}) as mock_post:
        await append_text(token_manager, "d1", "hello", "t.7")
        assert _location(mock_post) == {"segmentId": "", "tabId": "t.7"}


@pytest.mark.asyncio
async def test_append_text_treats_an_empty_tab_as_unnamed(token_manager):
    # The CLI hands through whatever --tab held, and "" means the flag
    # was absent; forwarding it would name a tab that cannot exist.
    with patch("mirage.core.gdocs.write.google_post",
               new_callable=AsyncMock,
               return_value={"documentId": "d1"}) as mock_post:
        await append_text(token_manager, "d1", "hello", "")
        assert _location(mock_post) == {"segmentId": ""}


@pytest.mark.asyncio
async def test_append_text_posts_to_the_batch_update_url(token_manager):
    with patch("mirage.core.gdocs.write.google_post",
               new_callable=AsyncMock,
               return_value={"documentId": "d1"}) as mock_post:
        await append_text(token_manager, "d1", "hello")
        assert mock_post.call_args.args[1] == (
            "https://docs.googleapis.com/v1/documents/d1:batchUpdate")
