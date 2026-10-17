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
from contextlib import aclosing
from pathlib import Path
from typing import Any

import pytest

from mirage.accessor.notion import NotionAccessor
from mirage.core.api.errors import PaginationStalledError
from mirage.core.notion import pages as pages_mod
from mirage.core.notion.client import NotionAPIError
from mirage.core.notion.config import NotionConfig

ROOT_ID = "aaaa1111-2222-3333-4444-555566667777"
NESTED_ID = "bbbb1111-2222-3333-4444-555566667777"
ACCESSOR = NotionAccessor(NotionConfig(api_key="key"))

CASES = json.loads(
    (
        Path(__file__).parents[4] / "integ/fixtures/notion/pagination.json"
    ).read_text()
)


class QueryReplies:
    def __init__(self, responses: list[dict[str, Any]]) -> None:
        self.responses = iter(responses)
        self.requests: list[dict[str, Any]] = []
        self.accessors: list[NotionAccessor] = []

    async def post(self, accessor, path, body):
        assert path == "/data_sources/ds/query"
        self.requests.append(dict(body))
        self.accessors.append(accessor)
        reply = next(self.responses)
        if "raise" in reply:
            raise NotionAPIError(**reply["raise"])
        return reply


def assert_query_error(exc: Exception, expected: dict[str, Any]) -> None:
    assert type(exc).__name__ == expected["kind"]
    assert str(exc) == expected["message"]
    if isinstance(exc, NotionAPIError):
        assert exc.status == expected["status"]
        assert exc.code == expected["code"]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
async def test_query_pages_shared_contract(monkeypatch, case):
    replies = QueryReplies(case["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    body = {"filter": {"property": "Done", "checkbox": {"equals": False}}}
    async with aclosing(
        pages_mod.query_data_source_pages(ACCESSOR, "ds", body=body)
    ) as pages:
        assert replies.requests == []
        for at, expected in enumerate(case["pages"], 1):
            assert await anext(pages) == expected
            assert len(replies.requests) == at
        if "error" in case:
            with pytest.raises(
                (NotionAPIError, PaginationStalledError)
            ) as exc:
                await anext(pages)
            assert_query_error(exc.value, case["error"])
        else:
            with pytest.raises(StopAsyncIteration):
                await anext(pages)
    assert [r.get("start_cursor") for r in replies.requests] == case["cursors"]
    assert all(r["filter"] == body["filter"] for r in replies.requests)
    assert all(r["page_size"] == 100 for r in replies.requests)
    assert all(seen is ACCESSOR for seen in replies.accessors)
    assert set(body) == {"filter"}


@pytest.mark.asyncio
@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
async def test_query_collector_shared_contract(monkeypatch, case):
    replies = QueryReplies(case["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    if "error" in case:
        with pytest.raises((NotionAPIError, PaginationStalledError)) as exc:
            await pages_mod.query_data_source(ACCESSOR, "ds")
        assert_query_error(exc.value, case["error"])
    else:
        rows = await pages_mod.query_data_source(ACCESSOR, "ds")
        assert rows == [row for page in case["pages"] for row in page]
    assert [r.get("start_cursor") for r in replies.requests] == case["cursors"]


@pytest.mark.asyncio
async def test_closing_query_pages_stops_requests(monkeypatch):
    replies = QueryReplies(CASES[0]["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    pages = pages_mod.query_data_source_pages(ACCESSOR, "ds")
    async with aclosing(pages):
        async for page in pages:
            assert page == CASES[0]["pages"][0]
            break
    with pytest.raises(StopAsyncIteration):
        await anext(pages)
    assert len(replies.requests) == 1


@pytest.mark.asyncio
async def test_query_pages_keep_initial_cursor_and_cap_page_size(monkeypatch):
    replies = QueryReplies(CASES[0]["responses"])
    monkeypatch.setattr(pages_mod, "notion_post", replies.post)
    body = {"start_cursor": "initial", "page_size": 7}
    async with aclosing(
        pages_mod.query_data_source_pages(
            ACCESSOR, "ds", page_size=250, body=body
        )
    ) as pages:
        assert await anext(pages) == CASES[0]["pages"][0]
        assert await anext(pages) == []
    assert replies.requests == [
        {"start_cursor": "initial", "page_size": 100},
        {"start_cursor": "c1", "page_size": 100},
    ]
    assert body == {"start_cursor": "initial", "page_size": 7}


_TREE: dict[str, list[dict[str, Any]]] = {
    f"/blocks/{ROOT_ID}/children": [
        {
            "id": NESTED_ID,
            "type": "toggle",
            "has_children": True,
        }
    ],
    f"/blocks/{NESTED_ID}/children": [
        {
            "id": "cccc1111-2222-3333-4444-555566667777",
            "type": "paragraph",
            "has_children": False,
        }
    ],
}


@pytest.mark.asyncio
async def test_block_tree_threads_one_session_through_every_level(monkeypatch):
    """The recursion dropped the session, so nested pages churned one
    ClientSession per block request while the top level rode the pool."""
    seen: list[NotionAccessor] = []

    async def fake_paginate_list(accessor, path, page_size=100):
        seen.append(accessor)
        return _TREE[path]

    monkeypatch.setattr(pages_mod, "paginate_list", fake_paginate_list)
    blocks = await pages_mod.list_block_tree(ACCESSOR, ROOT_ID)

    assert [b["id"] for b in blocks] == [NESTED_ID]
    assert len(seen) == 2
    assert all(s is ACCESSOR for s in seen)


@pytest.mark.asyncio
async def test_one_page_query_refuses_an_incomplete_page(monkeypatch):
    async def post(*_args, **_kwargs) -> dict[str, Any]:
        return {
            "results": [{"id": "partial"}],
            "has_more": False,
            "request_status": {
                "type": "incomplete",
                "incomplete_reason": "query_result_limit_reached",
            },
        }

    monkeypatch.setattr(pages_mod, "notion_post", post)
    with pytest.raises(NotionAPIError, match="query_result_limit_reached"):
        await pages_mod.query_data_source_page(
            ACCESSOR, "ds", {"page_size": 10}
        )
