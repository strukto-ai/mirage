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

from mirage.core.slack.search import (search_files_stream,
                                      search_messages_stream)
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_search_messages_stream_walks_pages_until_page_count():
    cfg = SlackConfig(token="xoxp-t")
    pages = [
        {
            "messages": {
                "matches": [{
                    "text": "a"
                }],
                "pagination": {
                    "page": 1,
                    "page_count": 3
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
                    "page_count": 3
                }
            }
        },
        {
            "messages": {
                "matches": [{
                    "text": "c"
                }],
                "pagination": {
                    "page": 3,
                    "page_count": 3
                }
            }
        },
    ]
    calls = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "search.messages"
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in search_messages_stream(cfg, "x"):
            seen.append([m["text"] for m in page])

    assert seen == [["a"], ["b"], ["c"]]
    assert [c["page"] for c in calls] == ["1", "2", "3"]
    assert calls[0]["sort"] == "timestamp"


@pytest.mark.asyncio
async def test_search_messages_stream_honors_max_pages():
    cfg = SlackConfig(token="xoxp-t")
    pages = [
        {
            "messages": {
                "matches": [{
                    "text": "a"
                }],
                "pagination": {
                    "page": 1,
                    "page_count": 10
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
                    "page_count": 10
                }
            }
        },
        {
            "messages": {
                "matches": [{
                    "text": "c"
                }],
                "pagination": {
                    "page": 3,
                    "page_count": 10
                }
            }
        },
    ]
    calls = {"n": 0}

    async def fake_get(_cfg, _method, params=None, token=None):
        page = pages[calls["n"]]
        calls["n"] += 1
        return page

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in search_messages_stream(cfg, "x", max_pages=2):
            seen.append(page)

    assert len(seen) == 2
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_search_files_stream_uses_files_endpoint():
    cfg = SlackConfig(token="xoxp-t")

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "search.files"
        return {
            "files": {
                "matches": [{
                    "id": "F1"
                }],
                "pagination": {
                    "page": 1,
                    "page_count": 1
                }
            }
        }

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in search_files_stream(cfg, "report"):
            seen.append(page)

    assert seen == [[{"id": "F1"}]]
