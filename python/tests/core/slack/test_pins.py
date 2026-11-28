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

from mirage.core.slack.pins import list_pins, pin_message, unpin_message
from tests.fixtures.slack_workspace import PINS, PINS_ADD, PINS_REMOVE

# "lunch at noon" in general.
LUNCH = "1762214460.000001"


@pytest.mark.asyncio
async def test_pin_message_posts_pins_add(slack_workspace):
    accessor = slack_workspace.accessor()
    result = await pin_message(accessor, "C1", LUNCH)
    assert result["ok"] is True
    assert await slack_workspace.run.bodies("POST", PINS_ADD) == [
        {"channel": "C1", "timestamp": LUNCH}
    ]
    pinned = await list_pins(accessor, "C1")
    assert [item["message"]["ts"] for item in pinned] == [LUNCH]


@pytest.mark.asyncio
async def test_unpin_message_posts_pins_remove(slack_workspace):
    await slack_workspace.pin("C1", LUNCH)
    accessor = slack_workspace.accessor()
    await unpin_message(accessor, "C1", LUNCH)
    assert await slack_workspace.run.bodies("POST", PINS_REMOVE) == [
        {"channel": "C1", "timestamp": LUNCH}
    ]
    assert await list_pins(accessor, "C1") == []


@pytest.mark.asyncio
async def test_list_pins_returns_items(slack_workspace):
    await slack_workspace.pin("C1", LUNCH)
    items = await list_pins(slack_workspace.accessor(), "C1")
    assert [(i["type"], i["message"]["text"]) for i in items] == [
        ("message", "lunch at noon")
    ]
    assert await slack_workspace.run.params("GET", PINS) == [{"channel": "C1"}]


@pytest.mark.asyncio
async def test_list_pins_tolerates_missing_items(slack_workspace):
    await slack_workspace.run.answer_next("GET", PINS, 200, {"ok": True})
    assert await list_pins(slack_workspace.accessor(), "C1") == []
