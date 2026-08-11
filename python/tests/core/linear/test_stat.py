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

from unittest.mock import AsyncMock

import pytest

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexEntry
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.linear import read as linear_read
from mirage.core.linear import readdir as linear_readdir
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.read import read_bytes
from mirage.core.linear.readdir import readdir
from mirage.core.linear.stat import stat
from mirage.types import FileType, PathSpec

_COMMENTS_PATH = ("/teams/ENG__Engineering__TEAM1/issues"
                  "/ENG-123__ISSUE1/comments.jsonl")

_ISSUE_PATH = ("/teams/ENG__Engineering__TEAM1/issues"
               "/ENG-123__ISSUE1/issue.json")


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


@pytest.fixture
def index():
    return RAMIndexCacheStore()


@pytest.mark.asyncio
async def test_stat_root(accessor, index):
    result = await stat(accessor, PathSpec.from_str_path("/"), index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_teams(accessor, index):
    result = await stat(accessor, PathSpec.from_str_path("/teams"), index)
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_team_entry(accessor, index):
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
    result = await stat(
        accessor, PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1"),
        index)
    assert result.type == FileType.DIRECTORY
    assert result.extra["team_id"] == "TEAM1"
    assert result.modified == "2026-04-05T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_directory(accessor, index):
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
    result = await stat(
        accessor,
        PathSpec.from_str_path(
            "/teams/ENG__Engineering__TEAM1/issues/ENG-123__ISSUE1"),
        index,
    )
    assert result.type == FileType.DIRECTORY
    assert result.extra["issue_id"] == "ISSUE1"
    assert result.modified == "2026-04-05T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_json(accessor, index):
    await index.put(
        _ISSUE_PATH,
        IndexEntry(
            id="ISSUE1",
            name="issue.json",
            resource_type="linear/issue_json",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="issue.json",
            size=321,
        ),
    )
    result = await stat(accessor, PathSpec.from_str_path(_ISSUE_PATH), index)
    assert result.type == FileType.JSON
    assert result.size == 321
    assert result.modified == "2026-04-05T00:00:00Z"
    assert result.extra["issue_id"] == "ISSUE1"


@pytest.mark.asyncio
async def test_stat_comments_jsonl(accessor, index):
    await index.put(
        _COMMENTS_PATH,
        IndexEntry(
            id="ISSUE1",
            name="comments.jsonl",
            resource_type="linear/comments",
            remote_time="2026-04-06T00:00:00Z",
            vfs_name="comments.jsonl",
            size=57,
        ),
    )
    result = await stat(accessor, PathSpec.from_str_path(_COMMENTS_PATH),
                        index)
    assert result.type == FileType.TEXT
    assert result.size == 57
    assert result.modified == "2026-04-06T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_team_json_reports_rendered_size(accessor, index):
    await index.put(
        "/teams/ENG__Engineering__TEAM1",
        IndexEntry(
            id="TEAM1",
            name="Engineering",
            resource_type="linear/team",
            remote_time="2026-04-05T00:00:00Z",
            vfs_name="ENG__Engineering__TEAM1",
            extra={
                "team_key": "ENG",
                "team_name": "Engineering",
                "team_json_size": 123,
            },
        ),
    )
    result = await stat(
        accessor,
        PathSpec.from_str_path("/teams/ENG__Engineering__TEAM1/team.json"),
        index)
    assert result.type == FileType.JSON
    assert result.size == 123
    assert result.modified == "2026-04-05T00:00:00Z"
    assert result.extra["team_id"] == "TEAM1"


@pytest.mark.asyncio
async def test_stat_missing_path(accessor, index):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec.from_str_path("/nonexistent/path"),
                   index)


_TEAM = {
    "id": "TEAM1",
    "key": "ENG",
    "name": "Engineering",
    "description": "Builds the thing",
    "timezone": "UTC",
    "updatedAt": "2026-04-05T00:00:00Z",
    "states": {
        "nodes": [{
            "id": "ST1",
            "name": "Todo",
            "type": "unstarted"
        }]
    },
}

_USERS = [{
    "id": "USER1",
    "name": "Alice",
    "displayName": "Alice",
    "email": "alice@example.com",
    "active": True,
    "admin": False,
    "url": "https://linear.app/u/alice",
    "updatedAt": "2026-04-01T00:00:00Z",
}]

_ISSUES = [
    {
        "id": "ISSUE1",
        "identifier": "ENG-1",
        "title": "Fix the naïve cache ✨",
        "description": "size-unknown files read as empty",
        "priority": 2,
        "url": "https://linear.app/i/ENG-1",
        "createdAt": "2026-04-02T00:00:00Z",
        "updatedAt": "2026-04-03T00:00:00Z",
        "team": {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering"
        },
        "state": {
            "id": "ST1",
            "name": "Todo"
        },
        "project": {
            "id": "PROJ1",
            "name": "Mount"
        },
        "cycle": {
            "id": "CYC1",
            "name": "Cycle 1",
            "number": 1
        },
        "assignee": {
            "id": "USER1",
            "name": "Alice",
            "email": "alice@example.com"
        },
        "creator": None,
        "labels": {
            "nodes": [{
                "id": "L1",
                "name": "bug"
            }]
        },
    },
    {
        "id": "ISSUE2",
        "identifier": "ENG-2",
        "title": "Second issue",
        "description": "",
        "priority": 0,
        "url": "https://linear.app/i/ENG-2",
        "createdAt": "2026-04-02T00:00:00Z",
        "updatedAt": "2026-04-04T00:00:00Z",
        "team": {
            "id": "TEAM1",
            "key": "ENG",
            "name": "Engineering"
        },
        "state": {
            "id": "ST1",
            "name": "Todo"
        },
        "project": None,
        "cycle": None,
        "assignee": None,
        "creator": None,
        "labels": {
            "nodes": []
        },
    },
]

_COMMENTS = {
    "ISSUE1": [{
        "id": "CMT1",
        "body": "résumé attached",
        "url": "https://linear.app/c/1",
        "createdAt": "2026-04-03T00:00:00Z",
        "updatedAt": "2026-04-03T12:00:00Z",
        "user": {
            "id": "USER1",
            "name": "Alice",
            "displayName": "Alice",
            "email": "alice@example.com",
        },
    }],
}

_PROJECTS = [{
    "id": "PROJ1",
    "name": "Mount",
    "description": "Mount everything",
    "status": {
        "type": "started"
    },
    "url": "https://linear.app/p/mount",
    "updatedAt": "2026-04-04T00:00:00Z",
    "lead": {
        "id": "USER1"
    },
}]

_CYCLES = [{
    "id": "CYC1",
    "name": "Cycle 1",
    "number": 1,
    "startsAt": "2026-04-01T00:00:00Z",
    "endsAt": "2026-04-14T00:00:00Z",
    "updatedAt": "2026-04-04T00:00:00Z",
}]

_DOCUMENTS = [{
    "id": "DOC1",
    "title": "Spec",
    "content": "unicode body ✓",
    "url": "https://linear.app/d/spec",
    "createdAt": "2026-04-01T00:00:00Z",
    "updatedAt": "2026-04-02T00:00:00Z",
    "project": {
        "id": "PROJ1",
        "name": "Mount"
    },
    "creator": {
        "id": "USER1",
        "name": "Alice",
        "email": "alice@example.com"
    },
}]


async def _issue_by_id(config, issue_id):
    return next(issue for issue in _ISSUES if issue["id"] == issue_id)


async def _comments_for(config, issue_id):
    return list(_COMMENTS.get(issue_id, []))


async def _walk_files(accessor, index):
    stack = ["/"]
    files = []
    while stack:
        current = stack.pop()
        listing = await readdir(
            accessor,
            PathSpec(resource_path=current.strip("/"),
                     virtual=current,
                     directory=current), index)
        for path in listing:
            entry_stat = await stat(accessor, PathSpec.from_str_path(path),
                                    index)
            if entry_stat.type == FileType.DIRECTORY:
                stack.append(path)
            else:
                files.append((path, entry_stat))
    return files


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(accessor, index,
                                                     monkeypatch):
    # The fskit invariant: whatever size stat reports at lookup must equal
    # the byte length a read delivers, for every file in the tree.
    fakes = {
        "list_teams": AsyncMock(return_value=[_TEAM]),
        "list_team_members": AsyncMock(return_value=_USERS),
        "list_team_issues": AsyncMock(return_value=_ISSUES),
        "list_team_projects": AsyncMock(return_value=_PROJECTS),
        "list_team_cycles": AsyncMock(return_value=_CYCLES),
        "list_team_documents": AsyncMock(return_value=_DOCUMENTS),
        "list_issue_comments": AsyncMock(side_effect=_comments_for),
        "get_issue": AsyncMock(side_effect=_issue_by_id),
    }
    for module in (linear_readdir, linear_read):
        for name, fake in fakes.items():
            monkeypatch.setattr(module, name, fake)
    files = await _walk_files(accessor, index)
    assert len(files) == 9
    # Sizing never refetches an issue: the issues listing already carries the
    # payloads, so walking the whole tree costs no per-file issue fetch.
    fakes["get_issue"].assert_not_awaited()
    for path, entry_stat in files:
        body = await read_bytes(accessor.config, path, path)
        assert entry_stat.size == len(body), path
