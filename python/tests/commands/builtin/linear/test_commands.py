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
from unittest.mock import AsyncMock, patch

import pytest

from mirage import MountMode, Workspace
from mirage.resource.linear import LinearConfig, LinearResource

MOCK_TEAMS = [{
    "id": "TEAM1",
    "key": "ENG",
    "name": "Engineering",
    "description": "Core team",
    "timezone": "UTC",
    "updatedAt": "2026-04-05T00:00:00Z",
    "states": {
        "nodes": [{
            "id": "STATE1",
            "name": "Todo",
            "type": "unstarted",
        }]
    },
}]

MOCK_ISSUES = [{
    "id": "ISSUE1",
    "identifier": "ENG-1",
    "title": "Fix login",
    "url": "https://linear.app/issue/ENG-1",
    "project": None,
    "state": {
        "id": "STATE1",
        "name": "Todo",
    },
}]

MOCK_ISSUE_DETAIL = {
    "id": "ISSUE1",
    "identifier": "ENG-1",
    "title": "Fix login",
    "description": "Login page broken",
    "priority": 2,
    "url": "https://linear.app/issue/ENG-1",
    "createdAt": "2026-04-05T00:00:00Z",
    "updatedAt": "2026-04-05T00:00:00Z",
    "team": {
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
    },
    "state": {
        "id": "STATE1",
        "name": "Todo",
    },
    "project": {},
    "cycle": {},
    "assignee": {},
    "creator": {
        "id": "USER1",
        "name": "Alice",
        "email": "alice@example.com",
    },
    "labels": {
        "nodes": []
    },
}

MOCK_COMMENTS = [{
    "id": "C1",
    "body": "looks good",
    "createdAt": "2026-04-05T00:00:00Z",
    "updatedAt": "2026-04-05T00:00:00Z",
    "url": "https://linear.app/comment",
    "user": {
        "id": "USER1",
        "name": "Alice",
        "displayName": "Alice",
        "email": "alice@example.com",
    },
}]


def _make_workspace():
    config = LinearConfig(api_key="lin_api_test")
    resource = LinearResource(config=config)
    return Workspace({"/linear": resource}, mode=MountMode.READ)


def _patches():
    return (
        patch("mirage.core.linear.readdir.list_teams",
              new_callable=AsyncMock,
              return_value=MOCK_TEAMS),
        patch("mirage.core.linear.readdir.list_team_issues",
              new_callable=AsyncMock,
              return_value=MOCK_ISSUES),
        patch("mirage.core.linear.readdir.list_team_projects",
              new_callable=AsyncMock,
              return_value=[]),
        patch("mirage.core.linear.readdir.list_team_members",
              new_callable=AsyncMock,
              return_value=[]),
        patch("mirage.core.linear.readdir.get_issue",
              new_callable=AsyncMock,
              return_value=MOCK_ISSUE_DETAIL),
        patch("mirage.core.linear.readdir.list_issue_comments",
              new_callable=AsyncMock,
              return_value=MOCK_COMMENTS),
        patch("mirage.core.linear.read.list_teams",
              new_callable=AsyncMock,
              return_value=MOCK_TEAMS),
        patch("mirage.core.linear.read.get_issue",
              new_callable=AsyncMock,
              return_value=MOCK_ISSUE_DETAIL),
        patch("mirage.core.linear.read.list_issue_comments",
              new_callable=AsyncMock,
              return_value=MOCK_COMMENTS),
        patch("mirage.core.linear.read.list_team_issues",
              new_callable=AsyncMock,
              return_value=MOCK_ISSUES),
        patch("mirage.core.linear.read.list_team_projects",
              new_callable=AsyncMock,
              return_value=[]),
    )


@pytest.fixture
def ws():
    return _make_workspace()


def _all_patches():
    patches = _patches()
    from contextlib import ExitStack
    stack = ExitStack()
    for p in patches:
        stack.enter_context(p)
    return stack


@pytest.mark.asyncio
async def test_ls_teams(ws):
    with _all_patches():
        r = await ws.execute("ls /linear/teams/")
    assert "ENG__Engineering__TEAM1" in (await r.stdout_str())
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_ls_issues(ws):
    with _all_patches():
        await ws.execute("ls /linear/teams/")
        r = await ws.execute("ls /linear/teams/ENG__Engineering__TEAM1/issues/"
                             )
    assert "ENG-1__ISSUE1" in (await r.stdout_str())
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_cat_issue(ws):
    with _all_patches():
        await ws.execute("ls /linear/teams/")
        r = await ws.execute("cat /linear/teams/ENG__Engineering__TEAM1"
                             "/issues/ENG-1__ISSUE1/issue.json")
    payload = json.loads(await r.stdout_str())
    assert payload["issue_key"] == "ENG-1"
    assert payload["title"] == "Fix login"
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_grep_issue(ws):
    with _all_patches():
        await ws.execute("ls /linear/teams/")
        r = await ws.execute("grep login /linear/teams/ENG__Engineering__TEAM1"
                             "/issues/ENG-1__ISSUE1/issue.json")
    assert "login" in (await r.stdout_str()).lower()
    assert r.exit_code == 0


@pytest.mark.asyncio
async def test_head_issue(ws):
    with _all_patches():
        await ws.execute("ls /linear/teams/")
        r = await ws.execute("head -n 3 /linear/teams/ENG__Engineering__TEAM1"
                             "/issues/ENG-1__ISSUE1/issue.json")
    assert r.exit_code == 0
    assert len((await r.stdout_str()).strip().splitlines()) <= 3


@pytest.mark.asyncio
async def test_stat_issue(ws):
    with _all_patches():
        await ws.execute("ls /linear/teams/")
        r = await ws.execute("stat /linear/teams/ENG__Engineering__TEAM1"
                             "/issues/ENG-1__ISSUE1/issue.json")
    assert r.exit_code == 0
