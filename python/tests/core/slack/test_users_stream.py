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

from mirage.core.slack.users import list_users_stream
from tests.fixtures.slack_workspace import USERS


@pytest.mark.asyncio
async def test_list_users_stream_walks_pages_and_filters(slack_workspace):
    # A first page of three, ana, ben and the bot, then the deactivated
    # user and Slackbot: each page yields only its people.
    await slack_workspace.first_page(USERS, 3)
    seen = [
        page async for page in list_users_stream(slack_workspace.accessor())
    ]
    assert [[u["name"] for u in page] for page in seen] == [["ana", "ben"], []]
    first, second = await slack_workspace.run.params("GET", USERS)
    assert first["limit"] == "200"
    assert second["cursor"] != ""
