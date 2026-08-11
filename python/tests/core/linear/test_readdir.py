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
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import (normalize_comment, normalize_issue,
                                          normalize_team, normalize_user,
                                          to_json_bytes, to_jsonl_bytes)
from mirage.core.linear.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

_ISSUE_DIR = "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_readdir_root(accessor, index):
    result = await readdir(
        accessor, PathSpec(resource_path="", virtual="/", directory="/"),
        index)
    assert result == ["/teams"]


@pytest.mark.asyncio
async def test_readdir_teams(accessor, index):
    teams = [{
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
        "updatedAt": "2026-04-05T00:00:00Z",
        "states": {
            "nodes": []
        },
    }]
    with patch("mirage.core.linear.readdir.list_teams",
               new_callable=AsyncMock,
               return_value=teams):
        result = await readdir(
            accessor,
            PathSpec(resource_path="teams",
                     virtual="/teams",
                     directory="/teams"), index)
    assert result == ["/teams/ENG__Engineering__TEAM1"]
    team_entry = await index.get("/teams/ENG__Engineering__TEAM1")
    assert team_entry.entry is not None
    assert team_entry.entry.extra["team_key"] == "ENG"
    assert team_entry.entry.extra["team_name"] == "Engineering"
    assert team_entry.entry.extra["team_json_size"] == len(
        to_json_bytes(normalize_team(teams[0])))


@pytest.mark.asyncio
async def test_readdir_teams_keeps_prefix_on_warm_cache_hit(accessor, index):
    teams = [{
        "id": "TEAM1",
        "key": "ENG",
        "name": "Engineering",
        "updatedAt": "2026-04-05T00:00:00Z",
        "states": {
            "nodes": []
        },
    }]
    spec = PathSpec(resource_path=mount_key("/linear/teams", "/linear"),
                    virtual="/linear/teams",
                    directory="/linear/teams")
    with patch("mirage.core.linear.readdir.list_teams",
               new_callable=AsyncMock,
               return_value=teams):
        cold = await readdir(accessor, spec, index)
        warm = await readdir(accessor, spec, index)
    assert cold == ["/linear/teams/ENG__Engineering__TEAM1"]
    assert warm == cold


@pytest.mark.asyncio
async def test_readdir_team_members(accessor, index):
    await index.put(
        "/teams/ENG__Engineering__TEAM1",
        IndexEntry(
            id="TEAM1",
            name="Engineering",
            resource_type="linear/team",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG__Engineering__TEAM1",
        ),
    )
    users = [{
        "id": "USER1",
        "name": "Alice",
        "displayName": "Alice",
        "email": "alice@example.com",
        "updatedAt": "2026-04-05T00:00:00Z",
    }]
    with patch("mirage.core.linear.readdir.list_team_members",
               new_callable=AsyncMock,
               return_value=users):
        result = await readdir(
            accessor,
            PathSpec(resource_path="teams/ENG__Engineering__TEAM1/members",
                     virtual="/teams/ENG__Engineering__TEAM1/members",
                     directory="/teams/ENG__Engineering__TEAM1/members"),
            index,
        )
    assert result == [
        "/teams/ENG__Engineering__TEAM1/members/Alice__USER1.json"
    ]
    member_entry = await index.get(
        "/teams/ENG__Engineering__TEAM1/members/Alice__USER1.json")
    assert member_entry.entry is not None
    assert member_entry.entry.size == len(
        to_json_bytes(normalize_user(users[0])))


@pytest.mark.asyncio
async def test_readdir_issue_folder(accessor, index):
    await index.put(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1",
        IndexEntry(
            id="ISSUE1",
            name="ENG-123",
            resource_type="linear/issue",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG-123__ISSUE1",
            extra={
                "issue_key": "ENG-123",
                "issue_json_size": 42
            },
        ),
    )
    comments = [{
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
    }]
    with patch("mirage.core.linear.readdir.list_issue_comments",
               new_callable=AsyncMock,
               return_value=comments):
        result = await readdir(
            accessor,
            PathSpec(
                resource_path=_ISSUE_DIR.strip("/"),
                virtual=_ISSUE_DIR,
                directory=_ISSUE_DIR,
            ),
            index,
        )
    assert result == [
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json",
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/comments.jsonl",
    ]
    issue_file = await index.get(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json")
    assert issue_file.entry is not None
    assert issue_file.entry.size == 42
    comments_file = await index.get(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/comments.jsonl")
    assert comments_file.entry is not None
    expected = to_jsonl_bytes([
        normalize_comment(comments[0], issue_id="ISSUE1", issue_key="ENG-123")
    ])
    assert comments_file.entry.size == len(expected)
    assert comments_file.entry.remote_time == "2026-04-06T00:00:00Z"


@pytest.mark.asyncio
async def test_readdir_issue_folder_fetches_issue_when_unsized(
        accessor, index):
    # An entry indexed before size push-down has no issue_json_size; the
    # readdir falls back to one issue fetch so the files are still sized.
    await index.put(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1",
        IndexEntry(
            id="ISSUE1",
            name="ENG-123",
            resource_type="linear/issue",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG-123__ISSUE1",
        ),
    )
    issue = {
        "id": "ISSUE1",
        "identifier": "ENG-123",
        "title": "Fix reads",
        "description": "reads return empty",
        "updatedAt": "2026-04-05T00:00:00Z",
    }
    with patch("mirage.core.linear.readdir.get_issue",
               new_callable=AsyncMock,
               return_value=issue) as fetched, \
         patch("mirage.core.linear.readdir.list_issue_comments",
               new_callable=AsyncMock,
               return_value=[]):
        await readdir(
            accessor,
            PathSpec(
                resource_path=_ISSUE_DIR.strip("/"),
                virtual=_ISSUE_DIR,
                directory=_ISSUE_DIR,
            ),
            index,
        )
    fetched.assert_awaited_once()
    issue_file = await index.get(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/issue.json")
    assert issue_file.entry is not None
    assert issue_file.entry.size == len(to_json_bytes(normalize_issue(issue)))
    comments_file = await index.get(
        "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1/comments.jsonl")
    assert comments_file.entry is not None
    assert comments_file.entry.size == 0


@pytest.mark.asyncio
async def test_readdir_unrecognized_path_raises(accessor, index):
    # Returning [] for an unknown path made `ls` and `tree` report a bogus path
    # as real-but-empty, and left `rg` without a message.
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="__nf_missing__",
                     virtual="/__nf_missing__",
                     directory="/__nf_missing__"), index)


@pytest.mark.asyncio
async def test_readdir_unrecognized_nested_path_raises(accessor, index):
    with pytest.raises(FileNotFoundError):
        await readdir(
            accessor,
            PathSpec(resource_path="teams/x/nope/deeper",
                     virtual="/teams/x/nope/deeper",
                     directory="/teams/x/nope/deeper"), index)
