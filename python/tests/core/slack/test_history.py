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

import pytest

from mirage.core.slack.history import fetch_messages_for_day, get_history_jsonl
from mirage.core.time_range import TimeRange
from tests.fixtures.slack_workspace import HISTORY

# general's first day: the deploy at 00:01, then ben's coffee at 01:00.
FIRST = "1762128060.000001"


@pytest.mark.asyncio
async def test_get_history_jsonl(slack_workspace):
    # Slack answers newest first; the day's lines run oldest first.
    result = await get_history_jsonl(
        slack_workspace.accessor(), "C1", "2025-11-03", TimeRange()
    )
    lines = [json.loads(line) for line in result.decode().splitlines()]
    assert [m["text"] for m in lines] == [
        "the deploy is done at acme",
        "coffee is ready",
    ]


@pytest.mark.asyncio
async def test_get_history_empty(slack_workspace):
    result = await get_history_jsonl(
        slack_workspace.accessor(), "C1", "2025-11-10", TimeRange()
    )
    assert result == b""


@pytest.mark.asyncio
async def test_messages_after_a_ts_start_past_it(slack_workspace):
    found = await fetch_messages_for_day(
        slack_workspace.accessor(),
        "C1",
        "2025-11-03",
        TimeRange(),
        after=FIRST,
    )
    assert [m["text"] for m in found] == ["coffee is ready"]
    [params] = await slack_workspace.run.params("GET", HISTORY)
    assert params["oldest"] == FIRST
