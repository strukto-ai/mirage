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
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.read import read
from mirage.core.linear.readdir import readdir
from mirage.core.linear.stat import stat
from mirage.types import PathSpec

_TEAM = "/teams/ENG__Engineering__TEAM1"
_ISSUE_PATH = (
    "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json"
)


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


def _entry(name: str, ident: str, kind: str) -> tuple[str, IndexEntry]:
    return (
        name,
        IndexEntry(
            id=ident, name=name, resource_type=f"linear/{kind}", vfs_name=name
        ),
    )


async def _seed(index: RAMIndexCacheStore, issue: bool = False) -> None:
    # The listings a traversal would have left: a read proves the file's
    # directory exists through them before fetching by the ids in the path.
    await index.set_dir(
        "/teams", [_entry("ENG__Engineering__TEAM1", "TEAM1", "team")]
    )
    if issue:
        await index.set_dir(
            _TEAM + "/issues", [_entry("ENG-123__ISSUE1", "ISSUE1", "issue")]
        )


@pytest.mark.asyncio
async def test_read_team_json(accessor, index):
    teams = [
        {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering",
            "description": "Core team",
            "timezone": "UTC",
            "updatedAt": "2026-04-05T00:00:00Z",
            "states": {
                "nodes": [
                    {
                        "id": "STATE1",
                        "name": "Todo",
                        "type": "unstarted",
                    }
                ]
            },
        }
    ]
    await _seed(index)
    with patch(
        "mirage.core.linear.readdir.list_teams",
        new_callable=AsyncMock,
        return_value=teams,
    ):
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
            "nodes": [
                {
                    "id": "L1",
                    "name": "bug",
                }
            ]
        },
    }
    await _seed(index, issue=True)
    with patch(
        "mirage.core.linear.read.get_issue",
        new_callable=AsyncMock,
        return_value=issue,
    ):
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
        "labels": {"nodes": []},
    }
    comments = [
        {
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
        }
    ]
    await _seed(index, issue=True)
    with (
        patch(
            "mirage.core.linear.read.get_issue",
            new_callable=AsyncMock,
            return_value=issue,
        ),
        patch(
            "mirage.core.linear.read.list_issue_comments",
            new_callable=AsyncMock,
            return_value=comments,
        ),
    ):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/teams/ENG__Engineering__TEAM1"
                "/issues/ENG-123__ISSUE1/comments.jsonl"
            ),
            index,
        )
    line = json.loads(result.decode().strip())
    assert line["comment_id"] == "COMMENT1"
    assert line["issue_id"] == "ISSUE1"


@pytest.mark.asyncio
async def test_read_project_json_includes_issue_refs(accessor, index):
    teams = [
        {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering",
            "updatedAt": "2026-04-05T00:00:00Z",
            "states": {"nodes": []},
        }
    ]
    projects = [
        {
            "id": "PROJ1",
            "name": "Agent Data Plane",
            "description": "Project body",
            "state": "planned",
            "updatedAt": "2026-04-05T00:00:00Z",
            "url": "https://linear.app/project",
            "lead": {
                "id": "USER1",
            },
        }
    ]
    issues = [
        {
            "id": "ISSUE1",
            "identifier": "ENG-123",
            "title": "Wire VFS",
            "url": "https://linear.app/issue",
            "project": {
                "id": "PROJ1",
            },
            "state": {
                "id": "STATE1",
                "name": "Todo",
            },
        }
    ]
    await _seed(index)
    with (
        patch(
            "mirage.core.linear.read.list_teams",
            new_callable=AsyncMock,
            return_value=teams,
        ),
        patch(
            "mirage.core.linear.read.list_team_projects",
            new_callable=AsyncMock,
            return_value=projects,
        ),
        patch(
            "mirage.core.linear.read.list_team_issues",
            new_callable=AsyncMock,
            return_value=issues,
        ),
    ):
        result = await read(
            accessor,
            PathSpec.from_str_path(
                "/teams/ENG__Engineering__TEAM1"
                "/projects/Agent-Data-Plane__PROJ1.json"
            ),
            index,
        )
    payload = json.loads(result)
    assert payload["team_key"] == "ENG"
    assert payload["team_name"] == "Engineering"
    assert payload["issue_count"] == 1
    assert payload["issues"][0]["issue_key"] == "ENG-123"


T1 = {"id": "TEAM1", "key": "ENG", "name": "Engineering"}
T2 = {"id": "TEAM2", "key": "FIN", "name": "Finance"}


@pytest.mark.asyncio
async def test_a_team_outside_team_ids_is_absent_on_every_surface(index):
    """The teams listing drops a team ``team_ids`` leaves out, and the
    issue read used to fetch straight by the id in the path: ``cat``
    served an issue of a team ``ls`` and ``stat`` reported absent."""
    accessor = LinearAccessor(
        LinearConfig(api_key="lin_api_test", team_ids=["TEAM1"])
    )
    get_issue = AsyncMock(return_value={"id": "ISSUE9"})
    list_members = AsyncMock(return_value=[{"id": "U9", "name": "Eve"}])
    secret = "/teams/FIN__Finance__TEAM2"
    with (
        patch(
            "mirage.core.linear.readdir.list_teams",
            AsyncMock(return_value=[T1, T2]),
        ),
        patch("mirage.core.linear.read.get_issue", get_issue),
        patch("mirage.core.linear.read.list_team_members", list_members),
    ):
        issue_json = PathSpec.from_str_path(
            secret + "/issues/FIN-9__ISSUE9/issue.json"
        )
        for surface in (read, stat):
            with pytest.raises(FileNotFoundError):
                await surface(accessor, issue_json, index)
        with pytest.raises(FileNotFoundError):
            await readdir(accessor, PathSpec.from_str_path(secret), index)
        with pytest.raises(FileNotFoundError):
            await read(
                accessor,
                PathSpec.from_str_path(secret + "/members/Eve__U9.json"),
                index,
            )
    get_issue.assert_not_awaited()
    list_members.assert_not_awaited()
