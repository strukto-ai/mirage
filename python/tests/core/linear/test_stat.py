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
from mirage.core.hierarchy.scope import Slot
from mirage.core.linear import read as linear_read
from mirage.core.linear import readdir as linear_readdir
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import (
    normalize_issue,
    normalize_team,
    to_json_bytes,
)
from mirage.core.linear.scope import detect_scope
from mirage.core.linear.stat import stat
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.linear import LinearVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import vfs_over

_ISSUE_DIR = "/teams/ENG__Engineering__TEAM1/issues/ENG-1__ISSUE1"


@pytest.fixture
def accessor():
    return LinearAccessor(LinearConfig(api_key="lin_api_test"))


_TEAM = {
    "id": "TEAM1",
    "key": "ENG",
    "name": "Engineering",
    "description": "Builds the thing",
    "timezone": "UTC",
    "updatedAt": "2026-04-05T00:00:00Z",
    "states": {"nodes": [{"id": "ST1", "name": "Todo", "type": "unstarted"}]},
}

_USERS = [
    {
        "id": "USER1",
        "name": "Alice",
        "displayName": "Alice",
        "email": "alice@example.com",
        "active": True,
        "admin": False,
        "url": "https://linear.app/u/alice",
        "updatedAt": "2026-04-01T00:00:00Z",
    }
]

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
        "team": {"id": "TEAM1", "key": "ENG", "name": "Engineering"},
        "state": {"id": "ST1", "name": "Todo"},
        "project": {"id": "PROJ1", "name": "Mount"},
        "cycle": {"id": "CYC1", "name": "Cycle 1", "number": 1},
        "assignee": {
            "id": "USER1",
            "name": "Alice",
            "email": "alice@example.com",
        },
        "creator": None,
        "labels": {"nodes": [{"id": "L1", "name": "bug"}]},
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
        "team": {"id": "TEAM1", "key": "ENG", "name": "Engineering"},
        "state": {"id": "ST1", "name": "Todo"},
        "project": None,
        "cycle": None,
        "assignee": None,
        "creator": None,
        "labels": {"nodes": []},
    },
]

_COMMENTS = {
    "ISSUE1": [
        {
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
        }
    ],
}

_PROJECTS = [
    {
        "id": "PROJ1",
        "name": "Mount",
        "description": "Mount everything",
        "status": {"type": "started"},
        "url": "https://linear.app/p/mount",
        "updatedAt": "2026-04-04T00:00:00Z",
        "lead": {"id": "USER1"},
    }
]

_CYCLES = [
    {
        "id": "CYC1",
        "name": "Cycle 1",
        "number": 1,
        "startsAt": "2026-04-01T00:00:00Z",
        "endsAt": "2026-04-14T00:00:00Z",
        "updatedAt": "2026-04-04T00:00:00Z",
    }
]

_DOCUMENTS = [
    {
        "id": "DOC1",
        "title": "Spec",
        "content": "unicode body ✓",
        "url": "https://linear.app/d/spec",
        "createdAt": "2026-04-01T00:00:00Z",
        "updatedAt": "2026-04-02T00:00:00Z",
        "project": {"id": "PROJ1", "name": "Mount"},
        "creator": {
            "id": "USER1",
            "name": "Alice",
            "email": "alice@example.com",
        },
    }
]


async def _issue_by_id(config, issue_id, session=None):
    return next(issue for issue in _ISSUES if issue["id"] == issue_id)


async def _comments_for(config, issue_id, session=None):
    return list(_COMMENTS.get(issue_id, []))


def _fake_tree(monkeypatch) -> dict[str, AsyncMock]:
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
            if hasattr(module, name):
                monkeypatch.setattr(module, name, fake)
    return fakes


def _mounted(accessor: LinearAccessor) -> Workspace:
    return Workspace({"/linear/": vfs_over(LinearVFS, accessor)})


async def _stat_at(accessor: LinearAccessor, path: str) -> FileStat:
    row, _ = await _mounted(accessor).dispatch(
        "stat", PathSpec.from_str_path("/linear" + path)
    )
    return row


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(accessor, PathSpec.from_str_path("/"))
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_teams(accessor):
    result = await stat(accessor, PathSpec.from_str_path("/teams"))
    assert result.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_team_entry(accessor, monkeypatch):
    _fake_tree(monkeypatch)
    result = await _stat_at(accessor, "/teams/ENG__Engineering__TEAM1")
    assert result.type == FileType.DIRECTORY
    assert result.extra["team_id"] == "TEAM1"
    assert result.modified == "2026-04-05T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_directory(accessor, monkeypatch):
    _fake_tree(monkeypatch)
    result = await _stat_at(accessor, _ISSUE_DIR)
    assert result.type == FileType.DIRECTORY
    assert result.extra["issue_id"] == "ISSUE1"
    assert result.modified == "2026-04-03T00:00:00Z"


@pytest.mark.asyncio
async def test_stat_issue_json(accessor, monkeypatch):
    _fake_tree(monkeypatch)
    result = await _stat_at(accessor, _ISSUE_DIR + "/issue.json")
    assert result.content == ContentType.JSON
    assert result.size == len(to_json_bytes(normalize_issue(_ISSUES[0])))
    assert result.modified == "2026-04-03T00:00:00Z"
    assert result.extra["issue_id"] == "ISSUE1"


@pytest.mark.asyncio
async def test_stat_comments_jsonl(accessor, monkeypatch):
    _fake_tree(monkeypatch)
    result = await _stat_at(accessor, _ISSUE_DIR + "/comments.jsonl")
    assert result.content == ContentType.TEXT
    assert result.modified == "2026-04-03T12:00:00Z"


@pytest.mark.asyncio
async def test_stat_team_json_reports_rendered_size(accessor, monkeypatch):
    # The team-dir listing computes team.json's size from the team object
    # the find already fetched, so stat answers the rendered byte length.
    _fake_tree(monkeypatch)
    result = await _stat_at(
        accessor, "/teams/ENG__Engineering__TEAM1/team.json"
    )
    assert result.content == ContentType.JSON
    assert result.size == len(to_json_bytes(normalize_team(_TEAM)))
    assert result.modified == "2026-04-05T00:00:00Z"
    assert result.extra["team_id"] == "TEAM1"


@pytest.mark.asyncio
async def test_stat_missing_path(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(accessor, PathSpec.from_str_path("/nonexistent/path"))


async def _walk_nodes(ws: Workspace) -> list[tuple[str, FileStat]]:
    """Every node below the mount, keyed by its path below it."""
    stack = ["/linear"]
    nodes = []
    while stack:
        current = stack.pop()
        listing, _ = await ws.dispatch(
            "readdir", PathSpec.from_str_path(current)
        )
        for path in listing:
            row, _ = await ws.dispatch("stat", PathSpec.from_str_path(path))
            if row.type == FileType.DIRECTORY:
                stack.append(path)
            nodes.append((path.removeprefix("/linear"), row))
    return nodes


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(accessor, monkeypatch):
    # The fskit invariant: whatever size stat reports at lookup must equal
    # the byte length a read delivers, for every file in the tree.
    fakes = _fake_tree(monkeypatch)
    ws = _mounted(accessor)
    files = [
        (path, row)
        for path, row in await _walk_nodes(ws)
        if row.type != FileType.DIRECTORY
    ]
    assert len(files) == 9
    # Sizing never refetches an issue: the issues listing already carries the
    # payloads, so walking the whole tree costs no per-file issue fetch.
    fakes["get_issue"].assert_not_awaited()
    for path, row in files:
        body, _ = await ws.dispatch(
            "read", PathSpec.from_str_path("/linear" + path)
        )
        assert row.size == len(body), path


def _deepest_id_key(path: str) -> str:
    match = detect_scope(PathSpec.from_str_path(path))
    assert match.scope is not None, path
    keys: list[str] = [
        segment.id_key
        for segment in match.scope.segments
        if isinstance(segment, Slot) and segment.id_key is not None
    ]
    return keys[-1]


@pytest.mark.asyncio
async def test_stat_extra_names_the_id_the_path_carries(accessor, monkeypatch):
    """Every id-addressed node's stat carries its id under the key its
    path slot names (team_id, member_id, issue_id, ...), the value the
    path encodes. The member kind wrote ``user_id`` while its slot and
    trello's member say ``member_id``."""
    _fake_tree(monkeypatch)
    nodes = await _walk_nodes(_mounted(accessor))
    assert any("/members/" in path for path, _ in nodes)
    for path, entry_stat in nodes:
        match = detect_scope(PathSpec.from_str_path(path))
        assert match.scope is not None, path
        if (
            isinstance(match.scope.segments[-1], str)
            and entry_stat.type == FileType.DIRECTORY
        ):
            continue
        id_key = _deepest_id_key(path)
        assert entry_stat.extra[id_key] == match.slots[id_key], path
