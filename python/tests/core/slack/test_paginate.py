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

from mirage.core.api.errors import PaginationStalledError
from mirage.core.slack.paginate import cursor_pages
from tests.fixtures.slack_workspace import LISTING, USERS

TYPES = "public_channel,private_channel"


@pytest.mark.asyncio
async def test_cursor_pages_walks_until_empty_cursor(slack_workspace):
    pages = [
        [channel["id"] for channel in page]
        async for page in cursor_pages(
            slack_workspace.accessor(),
            "conversations.list",
            base_params={"types": TYPES, "limit": 1},
            items_key="channels",
        )
    ]
    assert pages == [["C1"], ["C2"]]
    first, second = await slack_workspace.run.params("GET", LISTING)
    assert first == {"types": TYPES, "limit": "1"}
    assert second.pop("cursor") != ""
    assert second == first


@pytest.mark.asyncio
async def test_cursor_pages_propagates_cancellation(slack_workspace):
    gen = cursor_pages(
        slack_workspace.accessor(),
        "conversations.list",
        base_params={"types": TYPES, "limit": 1},
        items_key="channels",
    )
    first = await gen.__anext__()
    await gen.aclose()
    assert [channel["id"] for channel in first] == ["C1"]
    assert await slack_workspace.count(LISTING) == 1


@pytest.mark.asyncio
async def test_repeated_cursor_fails_without_a_third_request(slack_workspace):
    # A listing that answers the cursor it was asked with, twice running.
    reply = {
        "ok": True,
        "members": [],
        "response_metadata": {"next_cursor": "loop"},
    }
    await slack_workspace.run.answer_next("GET", USERS, 200, reply, times=2)
    async with slack_workspace.accessor() as accessor:
        with pytest.raises(PaginationStalledError, match="loop"):
            async for _ in cursor_pages(accessor, "users.list", {}, "members"):
                pass
    assert await slack_workspace.count(USERS) == 2
