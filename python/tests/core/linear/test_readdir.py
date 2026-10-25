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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.linear import LinearAccessor
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import (
    normalize_comment,
    normalize_issue,
    normalize_team,
    normalize_user,
    to_json_bytes,
)
from mirage.core.linear.readdir import readdir
from mirage.core.render.json import jsonl_bytes_by_created_at
from mirage.types import FileStat, FileType, PathSpec

_ISSUE_DIR = "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.mark.asyncio
async def test_readdir_root(accessor):
    result = await readdir(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert [row.name for row in result] == ["teams"]


@pytest.mark.asyncio
async def test_readdir_teams(accessor):
    teams = [
        {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering",
            "updatedAt": "2026-04-05T00:00:00Z",
            "states": {"nodes": []},
        }
    ]
    with patch(
        "mirage.core.linear.readdir.list_teams",
        new_callable=AsyncMock,
        return_value=teams,
    ):
        result = await readdir(
            accessor,
            PathSpec(vfs_path="teams", virtual="/teams", directory="/teams"),
        )
    assert [row.name for row in result] == ["ENG__Engineering__TEAM1"]
    team = result[0]
    assert team.extra["team_id"] == "TEAM1"
    assert team.extra["team_key"] == "ENG"
    assert team.extra["team_name"] == "Engineering"
    assert team.extra["json_size"] == len(
        to_json_bytes(normalize_team(teams[0]))
    )


_TEAM_STUB = {
    "id": "TEAM1",
    "key": "ENG",
    "name": "Engineering",
    "updatedAt": "2026-04-05T00:00:00Z",
    "states": {"nodes": []},
}


@pytest.mark.asyncio
async def test_readdir_team_members(accessor):
    users = [
        {
            "id": "USER1",
            "name": "Alice",
            "displayName": "Alice",
            "email": "alice@example.com",
            "updatedAt": "2026-04-05T00:00:00Z",
        }
    ]
    with (
        patch(
            "mirage.core.linear.readdir.list_teams",
            new_callable=AsyncMock,
            return_value=[_TEAM_STUB],
        ),
        patch(
            "mirage.core.linear.readdir.list_team_members",
            new_callable=AsyncMock,
            return_value=users,
        ),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="teams/ENG__Engineering__TEAM1/members",
                virtual="/teams/ENG__Engineering__TEAM1/members",
                directory="/teams/ENG__Engineering__TEAM1/members",
            ),
            FileStat(name="members", type=FileType.DIRECTORY),
        )
    assert [row.name for row in result] == ["Alice__USER1.json"]
    assert result[0].extra["member_id"] == "USER1"
    assert result[0].size == len(to_json_bytes(normalize_user(users[0])))


# A project's file names its issues, so the listing asks Linear for the
# issues of the projects it lists and no others.
@pytest.mark.asyncio
async def test_readdir_projects_asks_only_for_their_issues(accessor):
    projects = [
        {"id": "P1", "name": "Alpha", "updatedAt": "2026-04-05T00:00:00Z"},
        {"id": "P2", "name": "Beta", "updatedAt": "2026-04-05T00:00:00Z"},
    ]
    issues = AsyncMock(return_value=[])
    with (
        patch(
            "mirage.core.linear.readdir.list_teams",
            new_callable=AsyncMock,
            return_value=[_TEAM_STUB],
        ),
        patch(
            "mirage.core.linear.readdir.list_team_projects",
            new_callable=AsyncMock,
            return_value=projects,
        ),
        patch("mirage.core.linear.readdir.list_team_issues", issues),
    ):
        result = await readdir(
            accessor,
            PathSpec(
                vfs_path="teams/ENG__Engineering__TEAM1/projects",
                virtual="/teams/ENG__Engineering__TEAM1/projects",
                directory="/teams/ENG__Engineering__TEAM1/projects",
            ),
            FileStat(name="projects", type=FileType.DIRECTORY),
        )
    assert len(result) == 2
    issues.assert_awaited_once_with(accessor, "TEAM1", projects=["P1", "P2"])


@pytest.mark.asyncio
async def test_readdir_issue_folder(accessor):
    issue = {
        "id": "ISSUE1",
        "identifier": "ENG-123",
        "title": "Fix reads",
        "description": "reads return empty",
        "updatedAt": "2026-04-05T00:00:00Z",
    }
    comments = [
        {
            "id": "CMT1",
            "body": "first",
            "url": "https://linear.app/c/1",
            "createdAt": "2026-04-05T00:00:00Z",
            "updatedAt": "2026-04-06T00:00:00Z",
            "user": {
                "id": "USER1",
                "name": "Alice",
                "displayName": "Alice",
                "email": "alice@example.com",
            },
        }
    ]
    with (
        patch(
            "mirage.core.linear.readdir.list_teams",
            new_callable=AsyncMock,
            return_value=[_TEAM_STUB],
        ),
        patch(
            "mirage.core.linear.readdir.list_team_issues",
            new_callable=AsyncMock,
            return_value=[issue],
        ),
        patch(
            "mirage.core.linear.readdir.list_issue_comments",
            new_callable=AsyncMock,
            return_value=comments,
        ),
    ):
        issues_dir = _ISSUE_DIR.rsplit("/", 1)[0]
        (issue_row,) = await readdir(
            accessor,
            PathSpec(
                vfs_path=issues_dir.strip("/"),
                virtual=issues_dir,
                directory=issues_dir,
            ),
            FileStat(name="issues", type=FileType.DIRECTORY),
        )
        issue_file, comments_file = await readdir(
            accessor,
            PathSpec(
                vfs_path=_ISSUE_DIR.strip("/"),
                virtual=_ISSUE_DIR,
                directory=_ISSUE_DIR,
            ),
            issue_row,
        )
    assert issue_row.name == "ENG-123__ISSUE1"
    assert issue_file.name == "issue.json"
    assert comments_file.name == "comments.jsonl"
    # issue.json is sized from the issue the team listing already fetched,
    # never from a per-issue refetch.
    assert issue_file.size == len(to_json_bytes(normalize_issue(issue)))
    expected = jsonl_bytes_by_created_at(
        [
            normalize_comment(
                comments[0], issue_id="ISSUE1", issue_key="ENG-123"
            )
        ]
    )
    assert comments_file.size == len(expected)
    assert comments_file.modified == "2026-04-06T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="__nf_missing__",
                virtual="/__nf_missing__",
                directory="/__nf_missing__",
            ),
        )


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(
                vfs_path="teams/x/nope/deeper",
                virtual="/teams/x/nope/deeper",
                directory="/teams/x/nope/deeper",
            ),
        )
