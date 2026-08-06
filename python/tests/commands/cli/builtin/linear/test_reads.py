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

from mirage.commands.cli.builtin.linear import reads
from mirage.commands.cli.types import CLIInvocation
from mirage.core.linear.config import LinearConfig
from mirage.io.types import materialize

CONFIG = LinearConfig(api_key="lin_api_test")

TEAM = {"id": "team-1", "key": "ENG", "name": "Engineering"}


async def _json(out):
    return json.loads(await materialize(out))


@pytest.mark.asyncio
async def test_team_list_filters_config_team_ids(monkeypatch):

    async def fake_list_teams(config):
        return [{"id": "team-1"}, {"id": "team-2"}]

    def fake_normalize(team):
        return {"team_id": team["id"]}

    monkeypatch.setitem(reads.__dict__, "list_teams", fake_list_teams)
    monkeypatch.setitem(reads.__dict__, "normalize_team", fake_normalize)
    config = LinearConfig(api_key="k", team_ids=["team-2"])
    out, _io = await reads.team_list(CLIInvocation(config))
    assert await _json(out) == [{"team_id": "team-2"}]


@pytest.mark.asyncio
async def test_issue_get_resolves_issue_keys(monkeypatch):
    calls = []

    async def fake_resolve(config, issue_key=None, issue_id=None):
        calls.append(issue_key)
        return "issue-uuid"

    async def fake_get_issue(config, issue_id):
        return {"id": issue_id}

    def fake_normalize(issue):
        return {"issue_id": issue["id"]}

    monkeypatch.setitem(reads.__dict__["resolve_issue"].__globals__,
                        "resolve_issue_id", fake_resolve)
    monkeypatch.setitem(reads.__dict__, "get_issue", fake_get_issue)
    monkeypatch.setitem(reads.__dict__, "normalize_issue", fake_normalize)
    out, _io = await reads.issue_get(CLIInvocation(CONFIG, texts=("ENG-42", )))
    assert calls == ["ENG-42"]
    assert (await _json(out))["issue_id"] == "issue-uuid"


@pytest.mark.asyncio
async def test_issue_list_requires_team(monkeypatch):
    with pytest.raises(ValueError, match="--team is required"):
        await reads.issue_list(CLIInvocation(CONFIG))


@pytest.mark.asyncio
async def test_search_takes_flag_or_operand(monkeypatch):
    queries = []

    async def fake_search(config, query):
        queries.append(query)
        return [{"issue_key": "ENG-1"}]

    monkeypatch.setitem(reads.__dict__, "search_issues", fake_search)
    await reads.search(CLIInvocation(CONFIG, texts=("login bug", )))
    await reads.search(CLIInvocation(CONFIG, flags={"query": "crash"}))
    assert queries == ["login bug", "crash"]
    with pytest.raises(ValueError, match="query is required"):
        await reads.search(CLIInvocation(CONFIG))
