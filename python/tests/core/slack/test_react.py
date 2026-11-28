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

from mirage.core.slack.react import add_reaction, get_reactions
from tests.fixtures.slack_workspace import REACT, REACTIONS

# "lunch at noon" in general, which ana reacted to with a rocket.
LUNCH = "1762214460.000001"


@pytest.mark.asyncio
async def test_add_reaction_posts_reactions_add(slack_workspace):
    accessor = slack_workspace.accessor()
    await add_reaction(accessor, "C1", LUNCH, "shipit")
    assert await slack_workspace.run.bodies("POST", REACT) == [
        {"channel": "C1", "timestamp": LUNCH, "name": "shipit"}
    ]
    message = await get_reactions(accessor, "C1", LUNCH)
    assert [r["name"] for r in message["reactions"]] == ["rocket", "shipit"]


@pytest.mark.asyncio
async def test_get_reactions_returns_the_message_item(slack_workspace):
    message = await get_reactions(slack_workspace.accessor(), "C1", LUNCH)
    assert (message["ts"], message["reactions"]) == (
        LUNCH,
        [{"name": "rocket", "users": ["U1"], "count": 1}],
    )
    assert await slack_workspace.run.params("GET", REACTIONS) == [
        {"channel": "C1", "timestamp": LUNCH}
    ]
