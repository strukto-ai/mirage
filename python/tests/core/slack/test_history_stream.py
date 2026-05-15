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

from mirage.core.slack.history import (fetch_messages_for_day,
                                       stream_messages_for_day,
                                       stream_thread_replies)
from mirage.resource.slack.config import SlackConfig


@pytest.mark.asyncio
async def test_stream_messages_for_day_applies_day_bounds_and_yields_pages():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "messages": [{
                "ts": "1.0",
                "text": "a"
            }],
            "response_metadata": {
                "next_cursor": "cur1"
            },
        },
        {
            "messages": [{
                "ts": "2.0",
                "text": "b"
            }],
            "response_metadata": {
                "next_cursor": ""
            },
        },
    ]
    calls = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "conversations.history"
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in stream_messages_for_day(cfg, "C1", "2026-05-10"):
            seen.append(page)

    assert [m["text"] for m in seen[0]] == ["a"]
    assert [m["text"] for m in seen[1]] == ["b"]
    assert calls[0]["channel"] == "C1"
    assert calls[0]["inclusive"] == "true"
    assert "oldest" in calls[0]
    assert "latest" in calls[0]
    assert calls[1]["cursor"] == "cur1"


@pytest.mark.asyncio
async def test_fetch_messages_for_day_collects_and_sorts_across_pages():
    cfg = SlackConfig(token="xoxb-t")
    pages = [
        {
            "messages": [{
                "ts": "3.0"
            }, {
                "ts": "1.0"
            }],
            "response_metadata": {
                "next_cursor": "cur1"
            },
        },
        {
            "messages": [{
                "ts": "2.0"
            }],
            "response_metadata": {
                "next_cursor": ""
            },
        },
    ]
    calls = {"n": 0}

    async def fake_get(_cfg, _method, params=None, token=None):
        page = pages[calls["n"]]
        calls["n"] += 1
        return page

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        result = await fetch_messages_for_day(cfg, "C1", "2026-05-10")

    assert [m["ts"] for m in result] == ["1.0", "2.0", "3.0"]


@pytest.mark.asyncio
async def test_stream_thread_replies_uses_replies_endpoint_with_ts():
    cfg = SlackConfig(token="xoxb-t")
    calls = []

    async def fake_get(_cfg, method, params=None, token=None):
        assert method == "conversations.replies"
        calls.append(dict(params or {}))
        return {"messages": [], "response_metadata": {"next_cursor": ""}}

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        async for _ in stream_thread_replies(cfg, "C1", "1700000000.0"):
            pass

    assert calls[0]["channel"] == "C1"
    assert calls[0]["ts"] == "1700000000.0"
