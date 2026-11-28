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

from mirage.core.slack.emoji import list_emoji
from tests.fixtures.slack_workspace import EMOJI


@pytest.mark.asyncio
async def test_list_emoji_returns_mapping(slack_workspace):
    # The workspace's custom emoji: one image, one alias.
    emoji = await list_emoji(slack_workspace.accessor())
    assert emoji == {
        "shipit": "https://emoji.example/shipit.png",
        "partyparrot": "alias:parrot",
    }
    assert await slack_workspace.count(EMOJI) == 1


@pytest.mark.asyncio
async def test_list_emoji_tolerates_missing_key(slack_workspace):
    await slack_workspace.run.answer_next("GET", EMOJI, 200, {"ok": True})
    assert await list_emoji(slack_workspace.accessor()) == {}
