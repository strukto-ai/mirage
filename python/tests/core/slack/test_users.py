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

from mirage.core.slack.users import get_user_profile, list_users, search_users
from tests.fixtures.slack_workspace import USERS


@pytest.mark.asyncio
async def test_list_users(slack_workspace):
    # The workspace also holds a bot, a deactivated user and Slackbot,
    # none of whom is a person to list.
    result = await list_users(slack_workspace.accessor())
    assert [u["name"] for u in result] == ["ana", "ben"]


@pytest.mark.asyncio
async def test_search_users(slack_workspace):
    result = await search_users(slack_workspace.accessor(), "ana")
    assert [u["name"] for u in result] == ["ana"]


@pytest.mark.asyncio
async def test_search_users_by_email(slack_workspace):
    result = await search_users(slack_workspace.accessor(), "ben@example")
    assert [u["name"] for u in result] == ["ben"]


@pytest.mark.asyncio
async def test_get_user_profile(slack_workspace):
    result = await get_user_profile(slack_workspace.accessor(), "U1")
    assert (result["id"], result["name"]) == ("U1", "ana")


# A walk's limit stops the paging at the page that brings that many.
@pytest.mark.asyncio
async def test_list_users_pages_no_further_than_stop_at(slack_workspace):
    await slack_workspace.first_page(USERS, 1)
    result = await list_users(slack_workspace.accessor(), stop_at=1)
    assert [u["name"] for u in result] == ["ana"]
    assert await slack_workspace.count(USERS) == 1
