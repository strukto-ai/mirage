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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.read import read
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec

_ISSUE_PATH = ("/teams/ENG__Engineering__TEAM1/issues"
               "/ENG-123__ISSUE1/issue.json")


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_read_team_json(accessor, index):
    teams = [{
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
    with patch("mirage.core.linear.read.list_teams",
               new_callable=AsyncMock,
               return_value=teams):
        result = await read(
            accessor,
            PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1/team.json"),
            index,
        )
    payload = json.loads(result)
    assert payload["team_id"] == "TEAM1"
    assert payload["team_name"] == "Engineering"
    assert payload["states"][0]["state_id"] == "STATE1"


@pytest.mark.asyncio
async def test_read_issue_json(accessor, index):
    issue = {
        "id": "ISSUE1",
        "identifier": "ENG-123",
        "title": "Fix login",
        "description": "Body",
        "priority": 2,
        "url": "https://linear.app/issue",
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
        "project": {
            "id": "PROJ1",
            "name": "Project",
        },
        "cycle": {
            "id": "CYCLE1",
            "name": "Cycle",
            "number": 1,
        },
        "assignee": {
            "id": "USER1",
            "name": "Alice",
            "email": "alice@example.com",
        },
        "creator": {
            "id": "USER2",
            "name": "Bob",
            "email": "bob@example.com",
        },
        "labels": {
            "nodes": [{
                "id": "L1",
                "name": "bug",
            }]
        },
    }
    with patch("mirage.core.linear.read.get_issue",
               new_callable=AsyncMock,
               return_value=issue):
        result = await read(
            accessor,
            PathSpec.from_str_path(_ISSUE_PATH),
            index,
        )
    payload = json.loads(result)
    assert payload["issue_id"] == "ISSUE1"
    assert payload["assignee_id"] == "USER1"


@pytest.mark.asyncio
async def test_read_comments_jsonl(accessor, index):
    issue = {
        "id": "ISSUE1",
        "identifier": "ENG-123",
        "title": "Fix login",
        "description": "Body",
        "priority": 2,
        "url": "https://linear.app/issue",
        "createdAt": "2026-04-05T00:00:00Z",
        "updatedAt": "2026-04-05T00:00:00Z",
        "team": {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering",
        },
        "state": {},
        "project": {},
        "cycle": {},
        "assignee": {},
        "creator": {},
        "labels": {
            "nodes": []
        },
    }
    comments = [{
        "id": "COMMENT1",
        "body": "first",
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
    with patch("mirage.core.linear.read.get_issue",
               new_callable=AsyncMock,
               return_value=issue), patch(
                   "mirage.core.linear.read.list_issue_comments",
                   new_callable=AsyncMock,
                   return_value=comments):
        result = await read(
            accessor,
            PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1"
                                   "/issues/ENG-123__ISSUE1/comments.jsonl"),
            index,
        )
    line = json.loads(result.decode().strip())
    assert line["comment_id"] == "COMMENT1"
    assert line["issue_id"] == "ISSUE1"


@pytest.mark.asyncio
async def test_read_project_json_includes_issue_refs(accessor, index):
    teams = [{
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
        "updatedAt": "2026-04-05T00:00:00Z",
        "states": {
            "nodes": []
        },
    }]
    projects = [{
        "id": "PROJ1",
        "name": "Agent Data Plane",
        "description": "Project body",
        "state": "planned",
        "updatedAt": "2026-04-05T00:00:00Z",
        "url": "https://linear.app/project",
        "lead": {
            "id": "USER1",
        },
    }]
    issues = [{
        "id": "ISSUE1",
        "identifier": "ENG-123",
        "title": "Wire resource",
        "url": "https://linear.app/issue",
        "project": {
            "id": "PROJ1",
        },
        "state": {
            "id": "STATE1",
            "name": "Todo",
        },
    }]
    with patch("mirage.core.linear.read.list_teams",
               new_callable=AsyncMock,
               return_value=teams), patch(
                   "mirage.core.linear.read.list_team_projects",
                   new_callable=AsyncMock,
                   return_value=projects), patch(
                       "mirage.core.linear.read.list_team_issues",
                       new_callable=AsyncMock,
                       return_value=issues):
        result = await read(
            accessor,
            PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1"
                                   "/projects/Agent-Data-Plane__PROJ1.json"),
            index,
        )
    payload = json.loads(result)
    assert payload["team_key"] == "ENG"
    assert payload["team_name"] == "Engineering"
    assert payload["issue_count"] == 1
    assert payload["issues"][0]["issue_key"] == "ENG-123"
