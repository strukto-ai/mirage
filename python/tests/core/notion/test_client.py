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

from unittest.mock import patch

import pytest

from mirage.core.notion._client import (NotionAPIError, notion_headers,
                                        paginate_post)
from mirage.core.notion.config import NotionConfig


def test_notion_headers():
    config = NotionConfig(api_key="ntn_test123")
    headers = notion_headers(config)
    assert headers["Authorization"] == "Bearer ntn_test123"
    assert headers["Notion-Version"] == "2022-06-28"
    assert headers["Content-Type"] == "application/json"


def test_notion_api_error():
    err = NotionAPIError("bad request", status=400, code="invalid_json")
    assert str(err) == "bad request"
    assert err.status == 400
    assert err.code == "invalid_json"


@pytest.mark.asyncio
async def test_paginate_post_stops_at_max_results():
    calls = []

    async def fake_notion_post(config, path, body):
        calls.append(dict(body))
        return {
            "results": [{
                "n": len(calls) * 2 - 1
            }, {
                "n": len(calls) * 2
            }],
            "has_more": True,
            "next_cursor": f"c{len(calls)}",
        }

    config = NotionConfig(api_key="ntn_test123")
    with patch("mirage.core.notion._client.notion_post", new=fake_notion_post):
        results = await paginate_post(
            config,
            "/search",
            {},
            page_size=250,
            max_results=3,
        )
    assert [r["n"] for r in results] == [1, 2, 3]
    assert len(calls) == 2
    assert calls[0]["page_size"] == 100
