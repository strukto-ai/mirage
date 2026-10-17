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

import asyncio

from mirage.accessor.linear import LinearAccessor
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.events import LinearEventHook
from mirage.types import FileChangeKind, PathSpec

C, U, D, X = (
    FileChangeKind.CREATE,
    FileChangeKind.UPDATE,
    FileChangeKind.DELETE,
    FileChangeKind.UNKNOWN,
)
ENG = {"id": "t1", "key": "ENG", "name": "Engineering"}
OPS = {"id": "t2", "key": "OPS", "name": "Operations"}
ENG_DIR = "/l/teams/ENG__Engineering__t1"
ISSUE_DIR = f"{ENG_DIR}/issues/ENG-7__i1"


def _root() -> PathSpec:
    return PathSpec(virtual="/l", directory="/l", vfs_path="")


def _hook(monkeypatch, team_ids=None) -> tuple[LinearEventHook, list[str]]:
    calls: list[str] = []

    async def fake_teams(accessor):
        calls.append("teams")
        return [dict(ENG), dict(OPS)]

    async def fake_issue(accessor, issue_id):
        calls.append(f"issue {issue_id}")
        team = OPS if issue_id == "i1" else ENG
        return {"id": issue_id, "identifier": "ENG-9", "team": dict(team)}

    monkeypatch.setattr("mirage.core.linear.events.list_teams", fake_teams)
    monkeypatch.setattr("mirage.core.linear.events.get_issue", fake_issue)
    accessor = LinearAccessor(LinearConfig(api_key="k", team_ids=team_ids))
    return LinearEventHook(accessor), calls


def _issue(**fields) -> dict:
    return {"id": "i1", "identifier": "ENG-7", "team": dict(ENG), **fields}


def _map(hook, event_type, payload) -> list[tuple[FileChangeKind, str]]:
    events = asyncio.run(hook.to_events(_root(), event_type, payload))
    return [(e.kind, e.path.virtual) for e in events]


def test_an_issue_made_creates_both_files_and_needs_no_call(monkeypatch):
    hook, calls = _hook(monkeypatch)
    found = _map(hook, "Issue", {"action": "create", "data": _issue()})
    assert found == [
        (C, f"{ISSUE_DIR}/issue.json"),
        (C, f"{ISSUE_DIR}/comments.jsonl"),
    ]
    assert calls == []


def test_an_issue_edit_updates_issue_json(monkeypatch):
    hook, _ = _hook(monkeypatch)
    found = _map(
        hook,
        "Issue",
        {
            "action": "update",
            "data": _issue(priority=2),
            "updatedFrom": {"priority": 1},
        },
    )
    assert found == [(U, f"{ISSUE_DIR}/issue.json")]


def test_a_removed_or_archived_issue_leaves_and_a_restored_one_returns(
    monkeypatch,
):
    hook, _ = _hook(monkeypatch)
    removed = {"action": "remove", "data": _issue()}
    assert _map(hook, "Issue", removed) == [(D, ISSUE_DIR)]
    archived = {
        "action": "update",
        "data": _issue(archivedAt="2026-10-01T00:00:00.000Z"),
        "updatedFrom": {"archivedAt": None},
    }
    assert _map(hook, "Issue", archived) == [(D, ISSUE_DIR)]
    restored = {
        "action": "update",
        "data": _issue(archivedAt=None),
        "updatedFrom": {"archivedAt": "2026-10-01T00:00:00.000Z"},
    }
    assert [kind for kind, _ in _map(hook, "Issue", restored)] == [C, C]


def test_an_issue_moved_team_leaves_its_old_teams_listing(monkeypatch):
    hook, calls = _hook(monkeypatch)
    moved = {
        "action": "update",
        "data": {
            "id": "i1",
            "teamId": "t2",
            "number": 3,
            "team": dict(OPS),
            "projectId": "p1",
        },
        "updatedFrom": {"teamId": "t1", "number": 7},
    }
    ops = "/l/teams/OPS__Operations__t2"
    assert _map(hook, "Issue", moved) == [
        (X, f"{ENG_DIR}/issues"),
        (C, f"{ops}/issues/OPS-3__i1/issue.json"),
        (C, f"{ops}/issues/OPS-3__i1/comments.jsonl"),
        (X, f"{ENG_DIR}/projects"),
        (X, f"{ops}/projects"),
    ]
    assert calls == ["teams"]


def test_a_project_hears_only_of_the_fields_its_file_lists(monkeypatch):
    hook, _ = _hook(monkeypatch)
    quiet = {
        "action": "update",
        "data": _issue(projectId="p1"),
        "updatedFrom": {"priority": 1},
    }
    assert _map(hook, "Issue", quiet) == [(U, f"{ISSUE_DIR}/issue.json")]
    titled = {**quiet, "updatedFrom": {"title": "old"}}
    assert _map(hook, "Issue", titled) == [
        (U, f"{ISSUE_DIR}/issue.json"),
        (X, f"{ENG_DIR}/projects"),
    ]


def test_a_comment_reads_its_issue_once(monkeypatch):
    hook, calls = _hook(monkeypatch)
    comment = {"action": "create", "data": {"id": "c1", "issueId": "i9"}}
    path = f"{ENG_DIR}/issues/ENG-9__i9/comments.jsonl"
    assert _map(hook, "Comment", comment) == [(U, path)]
    assert _map(hook, "Comment", {**comment, "action": "remove"}) == [
        (U, path)
    ]
    assert calls == ["issue i9"]


def test_a_team_the_mount_leaves_out_maps_to_nothing(monkeypatch):
    hook, _ = _hook(monkeypatch, team_ids=["t2"])
    assert _map(hook, "Issue", {"action": "create", "data": _issue()}) == []
    assert _map(hook, "Project", {"action": "create", "data": {}}) == []


def test_an_issue_moved_to_a_team_left_out_is_forgotten(monkeypatch):
    hook, calls = _hook(monkeypatch, team_ids=["t1"])
    _map(hook, "Issue", {"action": "create", "data": _issue()})
    moved = {
        "action": "update",
        "data": {"id": "i1", "teamId": "t2", "team": dict(OPS)},
        "updatedFrom": {"teamId": "t1"},
    }
    assert _map(hook, "Issue", moved) == [(X, f"{ENG_DIR}/issues")]
    comment = {"action": "create", "data": {"id": "c1", "issueId": "i1"}}
    assert _map(hook, "Comment", comment) == []
    assert calls == ["issue i1"]
