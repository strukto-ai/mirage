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

from mirage.accessor.slack import SlackAccessor
from mirage.core.slack.config import SlackConfig
from mirage.core.slack.history import (
    fetch_messages_for_day,
    stream_messages_for_day,
)
from mirage.core.time_range import TimeRange


@pytest.mark.asyncio
async def test_stream_messages_for_day_applies_day_bounds_and_yields_pages():
    acc = SlackAccessor(SlackConfig(token="xoxb-t"))
    pages = [
        {
            "messages": [{"ts": "1778371201.0", "text": "a"}],
            "response_metadata": {"next_cursor": "cur1"},
        },
        {
            "messages": [{"ts": "1778371202.0", "text": "b"}],
            "response_metadata": {"next_cursor": ""},
        },
    ]
    calls = []

    async def fake_get(_acc, method, params=None):
        assert method == "conversations.history"
        calls.append(dict(params or {}))
        return pages[len(calls) - 1]

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        seen = []
        async for page in stream_messages_for_day(
            acc, "C1", "2026-05-10", TimeRange()
        ):
            seen.append(page)

    assert [m["text"] for m in seen[0]] == ["a"]
    assert [m["text"] for m in seen[1]] == ["b"]
    assert calls[0]["channel"] == "C1"
    assert calls[0]["inclusive"] == "true"
    assert calls[0]["oldest"] == "1778371200.000000"
    assert calls[0]["latest"] == "1778457600.000000"
    assert calls[1]["cursor"] == "cur1"


@pytest.mark.asyncio
async def test_fetch_messages_for_day_collects_and_sorts_across_pages():
    acc = SlackAccessor(SlackConfig(token="xoxb-t"))
    pages = [
        {
            "messages": [{"ts": "1778371203.0"}, {"ts": "1778371201.0"}],
            "response_metadata": {"next_cursor": "cur1"},
        },
        {
            "messages": [{"ts": "1778371202.0"}],
            "response_metadata": {"next_cursor": ""},
        },
    ]
    calls = {"n": 0}

    async def fake_get(_acc, _method, params=None):
        page = pages[calls["n"]]
        calls["n"] += 1
        return page

    with patch("mirage.core.slack.paginate.slack_get", new=fake_get):
        result = await fetch_messages_for_day(
            acc, "C1", "2026-05-10", TimeRange()
        )

    assert [m["ts"] for m in result] == [
        "1778371201.0",
        "1778371202.0",
        "1778371203.0",
    ]
