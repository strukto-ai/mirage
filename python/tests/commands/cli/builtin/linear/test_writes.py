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

import pytest

from mirage.commands.cli.builtin.linear.comment.add import add as comment_add
from mirage.commands.cli.builtin.linear.issue.add_label import add_label
from mirage.commands.cli.builtin.linear.issue.create import create
from mirage.commands.cli.builtin.linear.issue.set_priority import set_priority
from mirage.commands.cli.builtin.linear.issue.set_project import set_project
from mirage.commands.cli.builtin.linear.issue.transition import transition
from mirage.commands.cli.types import CLIInvocation
from mirage.core.linear.config import LinearConfig
from mirage.io.types import materialize

CONFIG = LinearConfig(api_key="lin_api_test")


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_create_resolves_team_and_reads_stdin(monkeypatch):

    async def fake_resolve_team(config, token):
        return {"id": "team-1", "key": token}

    async def fake_issue_create(config, *, team_id, title, description):
        return {
            "id": "i1",
            "team_id": team_id,
            "title": title,
            "description": description
        }

    def fake_normalize(issue):
        return issue

    monkeypatch.setitem(create.__globals__, "resolve_team", fake_resolve_team)
    monkeypatch.setitem(create.__globals__, "issue_create", fake_issue_create)
    monkeypatch.setitem(create.__globals__, "normalize_issue", fake_normalize)
    out, _io = await create(
        CLIInvocation(CONFIG,
                      flags={
                          "team": "ENG",
                          "title": "Title"
                      },
                      stdin=b"body from stdin"))
    data = await _json(out)
    assert data["team_id"] == "team-1"
    assert data["description"] == "body from stdin"


@pytest.mark.asyncio
async def test_transition_resolves_state_name(monkeypatch):

    async def fake_resolve_issue(config, token):
        return "issue-uuid"

    async def fake_list_teams(config):
        return [{
            "states": {
                "nodes": [{
                    "id": "state-2",
                    "name": "In Review"
                }]
            }
        }]

    async def fake_issue_update(config, *, issue_id, title, description,
                                state_id):
        return {"id": issue_id, "state_id": state_id}

    def fake_normalize(issue):
        return issue

    monkeypatch.setitem(transition.__globals__, "resolve_issue",
                        fake_resolve_issue)
    monkeypatch.setitem(transition.__globals__, "issue_update",
                        fake_issue_update)
    monkeypatch.setitem(transition.__globals__, "normalize_issue",
                        fake_normalize)
    resolve_state = transition.__globals__["resolve_state_id"]
    monkeypatch.setitem(resolve_state.__globals__, "list_teams",
                        fake_list_teams)
    out, _io = await transition(
        CLIInvocation(CONFIG,
                      texts=("ENG-42", ),
                      flags={"state_name": "In Review"}))
    assert (await _json(out))["state_id"] == "state-2"


@pytest.mark.asyncio
async def test_set_priority_forwards_int(monkeypatch):

    async def fake_resolve_issue(config, token):
        return "issue-uuid"

    async def fake_issue_update(config, *, issue_id, title, description,
                                priority):
        return {"id": issue_id, "priority": priority}

    def fake_normalize(issue):
        return issue

    monkeypatch.setitem(set_priority.__globals__, "resolve_issue",
                        fake_resolve_issue)
    monkeypatch.setitem(set_priority.__globals__, "issue_update",
                        fake_issue_update)
    monkeypatch.setitem(set_priority.__globals__, "normalize_issue",
                        fake_normalize)
    out, _io = await set_priority(
        CLIInvocation(CONFIG, texts=("ENG-42", ), flags={"priority": "2"}))
    assert (await _json(out))["priority"] == 2


@pytest.mark.asyncio
async def test_add_label_resolves_label_name(monkeypatch):

    async def fake_resolve_issue(config, token):
        return "issue-uuid"

    async def fake_get_issue(config, issue_id):
        return {
            "team": {
                "id": "team-1"
            },
            "labels": {
                "nodes": [{
                    "id": "lbl-old"
                }]
            },
        }

    async def fake_list_team_labels(config, team_id):
        assert team_id == "team-1"
        return [{"id": "lbl-bug", "name": "bug"}]

    async def fake_issue_update(config, *, issue_id, title, description,
                                label_ids):
        return {"id": issue_id, "label_ids": label_ids}

    def fake_normalize(issue):
        return issue

    monkeypatch.setitem(add_label.__globals__, "resolve_issue",
                        fake_resolve_issue)
    monkeypatch.setitem(add_label.__globals__, "get_issue", fake_get_issue)
    monkeypatch.setitem(add_label.__globals__, "issue_update",
                        fake_issue_update)
    monkeypatch.setitem(add_label.__globals__, "normalize_issue",
                        fake_normalize)
    resolve_label = add_label.__globals__["resolve_label_id"]
    monkeypatch.setitem(resolve_label.__globals__, "list_team_labels",
                        fake_list_team_labels)
    out, _io = await add_label(
        CLIInvocation(CONFIG, texts=("ENG-42", ), flags={"label_name": "bug"}))
    assert (await _json(out))["label_ids"] == ["lbl-old", "lbl-bug"]


@pytest.mark.asyncio
async def test_set_project_resolves_project_name(monkeypatch):

    async def fake_resolve_issue(config, token):
        return "issue-uuid"

    async def fake_get_issue(config, issue_id):
        return {"team": {"id": "team-1"}}

    async def fake_list_team_projects(config, team_id):
        assert team_id == "team-1"
        return [{"id": "prj-search", "name": "Search"}]

    async def fake_issue_update(config, *, issue_id, title, description,
                                project_id):
        return {"id": issue_id, "project_id": project_id}

    def fake_normalize(issue):
        return issue

    monkeypatch.setitem(set_project.__globals__, "resolve_issue",
                        fake_resolve_issue)
    monkeypatch.setitem(set_project.__globals__, "get_issue", fake_get_issue)
    monkeypatch.setitem(set_project.__globals__, "issue_update",
                        fake_issue_update)
    monkeypatch.setitem(set_project.__globals__, "normalize_issue",
                        fake_normalize)
    resolve_project = set_project.__globals__["resolve_project_id"]
    monkeypatch.setitem(resolve_project.__globals__, "list_team_projects",
                        fake_list_team_projects)
    out, _io = await set_project(
        CLIInvocation(CONFIG,
                      texts=("ENG-42", ),
                      flags={"project_name": "Search"}))
    assert (await _json(out))["project_id"] == "prj-search"


@pytest.mark.asyncio
async def test_comment_add_requires_body(monkeypatch):

    async def fake_resolve_issue(config, token):
        return "issue-uuid"

    monkeypatch.setitem(comment_add.__globals__, "resolve_issue",
                        fake_resolve_issue)
    with pytest.raises(ValueError, match="comment body is required"):
        await comment_add(CLIInvocation(CONFIG, texts=("ENG-42", )))
