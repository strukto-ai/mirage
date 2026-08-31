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
from aioresponses import aioresponses
from yarl import URL

from mirage.core.api.client import SessionArg, SessionPool
from mirage.core.notion.client import (NotionAPIError, notion_get,
                                       notion_headers, notion_post,
                                       paginate_list, paginate_post)
from mirage.core.notion.config import NotionConfig

BASE = "https://api.notion.com/v1"


def test_notion_headers():
    config = NotionConfig(api_key="ntn_test123")
    headers = notion_headers(config)
    assert headers["Authorization"] == "Bearer ntn_test123"
    assert headers["Notion-Version"] == "2025-09-03"
    assert headers["Content-Type"] == "application/json"


def test_notion_api_error():
    err = NotionAPIError("bad request", status=400, code="invalid_json")
    assert str(err) == "bad request"
    assert err.status == 400
    assert err.code == "invalid_json"


@pytest.mark.asyncio
async def test_paginate_post_stops_at_max_results():
    calls = []

    async def fake_notion_post(config, path, body, session=None):
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
    with patch("mirage.core.notion.client.notion_post", new=fake_notion_post):
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


@pytest.mark.asyncio
async def test_paginate_list_rides_one_session_across_pages():
    """The partial dropped the session, so every page of a cursor walk
    opened and closed its own ClientSession."""
    pool = SessionPool()
    seen: list[SessionArg] = []

    async def fake_notion_get(config, path, params=None, session=None):
        seen.append(session)
        more = len(seen) == 1
        return {
            "results": [{
                "n": len(seen)
            }],
            "has_more": more,
            "next_cursor": "c1" if more else None,
        }

    config = NotionConfig(api_key="ntn_test123")
    with patch("mirage.core.notion.client.notion_get", new=fake_notion_get):
        rows = await paginate_list(config, "/blocks/b1/children", session=pool)
    assert [r["n"] for r in rows] == [1, 2]
    assert len(seen) == 2
    assert all(s is pool for s in seen)


@pytest.mark.asyncio
async def test_notion_get_returns_the_body_and_sends_the_headers():
    config = NotionConfig(api_key="ntn_test123")
    with aioresponses() as m:
        m.get(f"{BASE}/users/me", payload={"object": "user", "id": "u1"})
        result = await notion_get(config, "/users/me")
        sent = m.requests[("GET", URL(f"{BASE}/users/me"))]
    assert result == {"object": "user", "id": "u1"}
    headers = sent[0].kwargs["headers"]
    assert headers["Authorization"] == "Bearer ntn_test123"
    assert headers["Notion-Version"] == "2025-09-03"


@pytest.mark.asyncio
async def test_notion_get_maps_an_error_body():
    config = NotionConfig(api_key="ntn_test123")
    with aioresponses() as m:
        m.get(f"{BASE}/pages/p1",
              status=404,
              payload={
                  "object": "error",
                  "message": "Could not find page",
                  "code": "object_not_found",
              })
        with pytest.raises(NotionAPIError) as exc:
            await notion_get(config, "/pages/p1")
    assert str(exc.value) == "Could not find page"
    assert exc.value.status == 404
    assert exc.value.code == "object_not_found"


@pytest.mark.asyncio
async def test_notion_error_without_a_message_reports_the_status():
    config = NotionConfig(api_key="ntn_test123")
    with aioresponses() as m:
        m.get(f"{BASE}/pages/p1", status=502, body="bad gateway")
        with pytest.raises(NotionAPIError) as exc:
            await notion_get(config, "/pages/p1")
    assert str(exc.value) == "Notion API error: HTTP 502"
    assert exc.value.code is None


@pytest.mark.asyncio
async def test_notion_post_sends_an_empty_object_for_no_body():
    config = NotionConfig(api_key="ntn_test123")
    with aioresponses() as m:
        m.post(f"{BASE}/search", payload={"results": []})
        await notion_post(config, "/search")
        sent = m.requests[("POST", URL(f"{BASE}/search"))]
    assert sent[0].kwargs["json"] == {}
