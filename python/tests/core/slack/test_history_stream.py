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

import pytest

from mirage.core.slack.history import (
    fetch_messages_for_day,
    stream_messages_for_day,
)
from mirage.core.time_range import TimeRange
from tests.fixtures.slack_workspace import HISTORY

DAY = {
    "channel": "C1",
    "oldest": "1762128000.000000",
    "latest": "1762214400.000000",
    "inclusive": "true",
}


@pytest.mark.asyncio
async def test_stream_messages_for_day_applies_day_bounds_and_yields_pages(
    slack_workspace,
):
    # Slack's first page holds one message, newest first, so the day comes
    # in two pages.
    await slack_workspace.first_page(HISTORY, 1, **DAY)
    seen = [
        page
        async for page in stream_messages_for_day(
            slack_workspace.accessor(), "C1", "2025-11-03", TimeRange()
        )
    ]
    assert [[m["text"] for m in page] for page in seen] == [
        ["coffee is ready"],
        ["the deploy is done at acme"],
    ]
    first, second = await slack_workspace.run.params("GET", HISTORY)
    assert {key: first[key] for key in DAY} == DAY
    assert second["cursor"] != ""


@pytest.mark.asyncio
async def test_fetch_messages_for_day_collects_and_sorts_across_pages(
    slack_workspace,
):
    await slack_workspace.first_page(HISTORY, 1, **DAY)
    result = await fetch_messages_for_day(
        slack_workspace.accessor(), "C1", "2025-11-03", TimeRange()
    )
    assert [m["ts"] for m in result] == [
        "1762128060.000001",
        "1762131600.000001",
    ]
    assert len(await slack_workspace.run.params("GET", HISTORY)) == 2
