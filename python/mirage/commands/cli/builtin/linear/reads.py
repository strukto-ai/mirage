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

import functools
from collections.abc import Awaitable, Callable

from mirage.commands.cli.builtin.linear.util import first_text, resolve_issue
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.types import FlagView
from mirage.core.linear._client import (get_issue, list_issue_comments,
                                        list_team_cycles, list_team_documents,
                                        list_team_issues, list_team_labels,
                                        list_team_members, list_team_projects,
                                        list_teams, resolve_team,
                                        search_issues)
from mirage.core.linear.config import LinearConfig
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_document, normalize_issue,
                                          normalize_label, normalize_project,
                                          normalize_team, normalize_user,
                                          to_json_bytes)
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue


def _require_team(fl: FlagView) -> str:
    team = fl.as_str("team")
    if not team:
        raise ValueError("--team is required")
    return team


async def _project_issue_rows(config: LinearConfig, team_id: str,
                              project_id: str) -> list[dict[str, JsonValue]]:
    team_issues = await list_team_issues(config, team_id)
    rows: list[dict[str, JsonValue]] = []
    for issue in team_issues:
        if (issue.get("project") or {}).get("id") != project_id:
            continue
        state = issue.get("state") or {}
        rows.append({
            "issue_id": issue.get("id"),
            "issue_key": issue.get("identifier"),
            "title": issue.get("title"),
            "state_id": state.get("id"),
            "state_name": state.get("name"),
            "url": issue.get("url"),
        })
    return rows


async def _run_team_list(config: LinearConfig, texts: tuple[str, ...],
                         fl: FlagView) -> bytes:
    teams = await list_teams(config)
    if config.team_ids:
        teams = [t for t in teams if t.get("id") in config.team_ids]
    return to_json_bytes([normalize_team(team) for team in teams])


async def _run_team_get(config: LinearConfig, texts: tuple[str, ...],
                        fl: FlagView) -> bytes:
    team = await resolve_team(config, first_text(texts, "team key"))
    return to_json_bytes(normalize_team(team))


async def _run_team_members(config: LinearConfig, texts: tuple[str, ...],
                            fl: FlagView) -> bytes:
    team = await resolve_team(config, first_text(texts, "team key"))
    users = await list_team_members(config, team["id"])
    return to_json_bytes([normalize_user(user) for user in users])


async def _run_issue_list(config: LinearConfig, texts: tuple[str, ...],
                          fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    issues = await list_team_issues(config, team["id"])
    return to_json_bytes([normalize_issue(issue) for issue in issues])


async def _run_issue_get(config: LinearConfig, texts: tuple[str, ...],
                         fl: FlagView) -> bytes:
    issue_id = await resolve_issue(config, first_text(texts, "issue key"))
    issue = await get_issue(config, issue_id)
    return to_json_bytes(normalize_issue(issue))


async def _run_project_list(config: LinearConfig, texts: tuple[str, ...],
                            fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    projects = await list_team_projects(config, team["id"])
    payload = []
    for project in projects:
        rows = await _project_issue_rows(config, team["id"], project["id"])
        payload.append(
            normalize_project(project,
                              team_id=team["id"],
                              team_key=team.get("key"),
                              team_name=team.get("name"),
                              issues=rows))
    return to_json_bytes(payload)


async def _run_project_get(config: LinearConfig, texts: tuple[str, ...],
                           fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    project_id = first_text(texts, "project id")
    projects = await list_team_projects(config, team["id"])
    for project in projects:
        if project.get("id") == project_id:
            rows = await _project_issue_rows(config, team["id"], project_id)
            return to_json_bytes(
                normalize_project(project,
                                  team_id=team["id"],
                                  team_key=team.get("key"),
                                  team_name=team.get("name"),
                                  issues=rows))
    raise FileNotFoundError(project_id)


async def _run_cycle_list(config: LinearConfig, texts: tuple[str, ...],
                          fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    cycles = await list_team_cycles(config, team["id"])
    return to_json_bytes(
        [normalize_cycle(cycle, team_id=team["id"]) for cycle in cycles])


async def _run_cycle_current(config: LinearConfig, texts: tuple[str, ...],
                             fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    cycles = await list_team_cycles(config, team["id"])
    if not cycles:
        raise FileNotFoundError("no cycles")
    current = max(cycles, key=lambda cycle: cycle.get("number") or 0)
    return to_json_bytes(normalize_cycle(current, team_id=team["id"]))


async def _run_cycle_get(config: LinearConfig, texts: tuple[str, ...],
                         fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    cycle_id = first_text(texts, "cycle id")
    cycles = await list_team_cycles(config, team["id"])
    for cycle in cycles:
        if cycle.get("id") == cycle_id:
            return to_json_bytes(normalize_cycle(cycle, team_id=team["id"]))
    raise FileNotFoundError(cycle_id)


async def _run_label_list(config: LinearConfig, texts: tuple[str, ...],
                          fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    labels = await list_team_labels(config, team["id"])
    return to_json_bytes([normalize_label(label) for label in labels])


async def _run_comment_list(config: LinearConfig, texts: tuple[str, ...],
                            fl: FlagView) -> bytes:
    issue_id = await resolve_issue(config, first_text(texts, "issue key"))
    issue = await get_issue(config, issue_id)
    issue_key = issue.get("identifier")
    comments = await list_issue_comments(config, issue_id)
    return to_json_bytes([
        normalize_comment(comment, issue_id=issue_id, issue_key=issue_key)
        for comment in comments
    ])


async def _all_users(config: LinearConfig) -> list[dict[str, JsonValue]]:
    teams = await list_teams(config)
    seen: set[str] = set()
    users: list[dict[str, JsonValue]] = []
    for team in teams:
        for user in await list_team_members(config, team["id"]):
            uid = user.get("id")
            if not isinstance(uid, str) or uid in seen:
                continue
            seen.add(uid)
            users.append(user)
    return users


async def _run_user_list(config: LinearConfig, texts: tuple[str, ...],
                         fl: FlagView) -> bytes:
    users = await _all_users(config)
    return to_json_bytes([normalize_user(user) for user in users])


async def _run_user_get(config: LinearConfig, texts: tuple[str, ...],
                        fl: FlagView) -> bytes:
    email = first_text(texts, "user email")
    for user in await _all_users(config):
        if user.get("email") == email:
            return to_json_bytes(normalize_user(user))
    raise FileNotFoundError(email)


async def _run_document_list(config: LinearConfig, texts: tuple[str, ...],
                             fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    documents = await list_team_documents(config, team["id"])
    return to_json_bytes(
        [normalize_document(document) for document in documents])


async def _run_document_get(config: LinearConfig, texts: tuple[str, ...],
                            fl: FlagView) -> bytes:
    team = await resolve_team(config, _require_team(fl))
    document_id = first_text(texts, "document id")
    documents = await list_team_documents(config, team["id"])
    for document in documents:
        if document.get("id") == document_id:
            return to_json_bytes(normalize_document(document))
    raise FileNotFoundError(document_id)


async def _run_search(config: LinearConfig, texts: tuple[str, ...],
                      fl: FlagView) -> bytes:
    query = fl.as_str("query") or (texts[0] if texts else None)
    if not query:
        raise ValueError("a search query is required")
    results = await search_issues(config, query)
    return to_json_bytes(results)


Runner = Callable[[LinearConfig, tuple[str, ...], FlagView], Awaitable[bytes]]


async def _dispatch(
        runner: Runner, inv: CLIInvocation[LinearConfig]
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(inv.flags)
    data = await runner(inv.config, inv.texts, fl)
    return yield_bytes(data), IOResult()


team_list = functools.partial(_dispatch, _run_team_list)
team_get = functools.partial(_dispatch, _run_team_get)
team_members = functools.partial(_dispatch, _run_team_members)
issue_list = functools.partial(_dispatch, _run_issue_list)
issue_get = functools.partial(_dispatch, _run_issue_get)
project_list = functools.partial(_dispatch, _run_project_list)
project_get = functools.partial(_dispatch, _run_project_get)
cycle_list = functools.partial(_dispatch, _run_cycle_list)
cycle_current = functools.partial(_dispatch, _run_cycle_current)
cycle_get = functools.partial(_dispatch, _run_cycle_get)
label_list = functools.partial(_dispatch, _run_label_list)
comment_list = functools.partial(_dispatch, _run_comment_list)
user_list = functools.partial(_dispatch, _run_user_list)
user_get = functools.partial(_dispatch, _run_user_get)
document_list = functools.partial(_dispatch, _run_document_list)
document_get = functools.partial(_dispatch, _run_document_get)
search = functools.partial(_dispatch, _run_search)
