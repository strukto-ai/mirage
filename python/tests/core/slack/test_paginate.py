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

from mirage.core.slack.paginate import cursor_pages, offset_pages
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_cursor_pages_walks_until_empty_cursor():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "items": [1, 2],
            "response_metadata": {
                "next_cursor": "cur1"
            }
        },
        {
            "items": [3],
            "response_metadata": {
                "next_cursor": ""
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, _method, params=None, token=None):
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        result = []
        async for page in cursor_pages(cfg,
                                       "conversations.list",
                                       base_params={
                                           "types": "x",
                                           "limit": 100
                                       },
                                       items_key="items"):
            result.append(page)
    assert result == [[1, 2], [3]]
    assert calls[0] == {"types": "x", "limit": 100}
    assert calls[1] == {"types": "x", "limit": 100, "cursor": "cur1"}


@pytest.mark.asyncio
async def test_cursor_pages_propagates_cancellation():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "items": [1],
            "response_metadata": {
                "next_cursor": "cur1"
            }
        },
        {
            "items": [2],
            "response_metadata": {
                "next_cursor": "cur2"
            }
        },
        {
            "items": [3],
            "response_metadata": {
                "next_cursor": ""
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, _method, params=None, token=None):
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        gen = cursor_pages(cfg,
                           "conversations.list",
                           base_params={"limit": 1},
                           items_key="items")
        first = await gen.__anext__()
        await gen.aclose()
    assert first == [1]
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_offset_pages_walks_search_messages_pagination():
    cfg = SlackConfig(token="xoxp-t")
    pages = [
        {
            "messages": {
                "matches": [{
                    "text": "a"
                }],
                "pagination": {
                    "page": 1,
                    "page_count": 2
                }
            }
        },
        {
            "messages": {
                "matches": [{
                    "text": "b"
                }],
                "pagination": {
                    "page": 2,
                    "page_count": 2
                }
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, _method, params=None, token=None):
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        result = []
        async for page in offset_pages(cfg,
                                       "search.messages",
                                       base_params={
                                           "query": "x",
                                           "count": "100"
                                       },
                                       pages_path=("messages", "pagination",
                                                   "page_count"),
                                       items_path=("messages", "matches"),
                                       start_page=1,
                                       max_pages=None):
            result.append(page)
    assert result == [[{"text": "a"}], [{"text": "b"}]]
    assert calls[0]["page"] == "1"
    assert calls[1]["page"] == "2"
