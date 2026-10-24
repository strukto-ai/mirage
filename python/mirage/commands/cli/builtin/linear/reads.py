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

from mirage.accessor.linear import LinearAccessor
from mirage.commands.cli.builtin.linear.util import first_text, resolve_issue
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.core.linear.client import (
    get_issue,
    list_issue_comments,
    list_team_cycles,
    list_team_documents,
    list_team_issues,
    list_team_labels,
    list_team_members,
    list_team_projects,
    list_teams,
    resolve_team,
    search_issues,
)
from mirage.core.linear.normalize import (
    normalize_comment,
    normalize_cycle,
    normalize_document,
    normalize_issue,
    normalize_label,
    normalize_project,
    normalize_team,
    normalize_user,
    to_json_bytes,
)
from mirage.io.types import ByteSource, IOResult
from mirage.types import JsonValue, PathSpec


def _require_team(fl: FlagView) -> str:
    team = fl.as_str("team")
    if not team:
        raise ValueError("--team is required")
    return team


async def _project_issue_rows(
    accessor: LinearAccessor, team_id: str, project_id: str
) -> list[dict[str, JsonValue]]:
    team_issues = await list_team_issues(accessor, team_id)
    rows: list[dict[str, JsonValue]] = []
    for issue in team_issues:
        if (issue.get("project") or {}).get("id") != project_id:
            continue
        state = issue.get("state") or {}
        rows.append(
            {
                "issue_id": issue.get("id"),
                "issue_key": issue.get("identifier"),
                "title": issue.get("title"),
                "state_id": state.get("id"),
                "state_name": state.get("name"),
                "url": issue.get("url"),
            }
        )
    return rows


async def _team_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    teams = await list_teams(accessor)
    team_ids = accessor.config.team_ids
    if team_ids:
        teams = [t for t in teams if t.get("id") in team_ids]
    return to_json_bytes([normalize_team(team) for team in teams])


async def _team_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, first_text(texts, "team key"))
    return to_json_bytes(normalize_team(team))


async def _team_members(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, first_text(texts, "team key"))
    users = await list_team_members(accessor, team["id"])
    return to_json_bytes([normalize_user(user) for user in users])


async def _issue_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    issues = await list_team_issues(accessor, team["id"])
    return to_json_bytes([normalize_issue(issue) for issue in issues])


async def _issue_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    issue_id = await resolve_issue(accessor, first_text(texts, "issue key"))
    issue = await get_issue(accessor, issue_id)
    return to_json_bytes(normalize_issue(issue))


async def _project_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    projects = await list_team_projects(accessor, team["id"])
    payload = []
    for project in projects:
        rows = await _project_issue_rows(accessor, team["id"], project["id"])
        payload.append(
            normalize_project(
                project,
                team_id=team["id"],
                team_key=team.get("key"),
                team_name=team.get("name"),
                issues=rows,
            )
        )
    return to_json_bytes(payload)


async def _project_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    project_id = first_text(texts, "project id")
    projects = await list_team_projects(accessor, team["id"])
    for project in projects:
        if project.get("id") == project_id:
            rows = await _project_issue_rows(accessor, team["id"], project_id)
            return to_json_bytes(
                normalize_project(
                    project,
                    team_id=team["id"],
                    team_key=team.get("key"),
                    team_name=team.get("name"),
                    issues=rows,
                )
            )
    raise FileNotFoundError(project_id)


async def _cycle_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    cycles = await list_team_cycles(accessor, team["id"])
    return to_json_bytes(
        [normalize_cycle(cycle, team_id=team["id"]) for cycle in cycles]
    )


async def _cycle_current(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    cycles = await list_team_cycles(accessor, team["id"])
    if not cycles:
        raise FileNotFoundError("no cycles")
    current = max(cycles, key=lambda cycle: cycle.get("number") or 0)
    return to_json_bytes(normalize_cycle(current, team_id=team["id"]))


async def _cycle_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    cycle_id = first_text(texts, "cycle id")
    cycles = await list_team_cycles(accessor, team["id"])
    for cycle in cycles:
        if cycle.get("id") == cycle_id:
            return to_json_bytes(normalize_cycle(cycle, team_id=team["id"]))
    raise FileNotFoundError(cycle_id)


async def _label_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    labels = await list_team_labels(accessor, team["id"])
    return to_json_bytes([normalize_label(label) for label in labels])


async def _comment_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    issue_id = await resolve_issue(accessor, first_text(texts, "issue key"))
    issue = await get_issue(accessor, issue_id)
    issue_key = issue.get("identifier")
    comments = await list_issue_comments(accessor, issue_id)
    return to_json_bytes(
        [
            normalize_comment(comment, issue_id=issue_id, issue_key=issue_key)
            for comment in comments
        ]
    )


async def _all_users(accessor: LinearAccessor) -> list[dict[str, JsonValue]]:
    teams = await list_teams(accessor)
    seen: set[str] = set()
    users: list[dict[str, JsonValue]] = []
    for team in teams:
        for user in await list_team_members(accessor, team["id"]):
            uid = user.get("id")
            if not isinstance(uid, str) or uid in seen:
                continue
            seen.add(uid)
            users.append(user)
    return users


async def _user_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    users = await _all_users(accessor)
    return to_json_bytes([normalize_user(user) for user in users])


async def _user_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    email = first_text(texts, "user email")
    for user in await _all_users(accessor):
        if user.get("email") == email:
            return to_json_bytes(normalize_user(user))
    raise FileNotFoundError(email)


async def _document_list(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    documents = await list_team_documents(accessor, team["id"])
    return to_json_bytes(
        [normalize_document(document) for document in documents]
    )


async def _document_get(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    team = await resolve_team(accessor, _require_team(fl))
    document_id = first_text(texts, "document id")
    documents = await list_team_documents(accessor, team["id"])
    for document in documents:
        if document.get("id") == document_id:
            return to_json_bytes(normalize_document(document))
    raise FileNotFoundError(document_id)


async def _search(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> bytes:
    query = fl.as_str("query") or (texts[0] if texts else None)
    if not query:
        raise ValueError("a search query is required")
    results = await search_issues(accessor, query)
    return to_json_bytes(results)


Runner = Callable[[LinearAccessor, list[str], FlagView], Awaitable[bytes]]


async def _dispatch(
    runner: Runner,
    accessor: LinearAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags)
    data = await runner(accessor, texts, fl)
    return data, IOResult()


team_list = functools.partial(_dispatch, _team_list)
team_get = functools.partial(_dispatch, _team_get)
team_members = functools.partial(_dispatch, _team_members)
issue_list = functools.partial(_dispatch, _issue_list)
issue_get = functools.partial(_dispatch, _issue_get)
project_list = functools.partial(_dispatch, _project_list)
project_get = functools.partial(_dispatch, _project_get)
cycle_list = functools.partial(_dispatch, _cycle_list)
cycle_current = functools.partial(_dispatch, _cycle_current)
cycle_get = functools.partial(_dispatch, _cycle_get)
label_list = functools.partial(_dispatch, _label_list)
comment_list = functools.partial(_dispatch, _comment_list)
user_list = functools.partial(_dispatch, _user_list)
user_get = functools.partial(_dispatch, _user_get)
document_list = functools.partial(_dispatch, _document_list)
document_get = functools.partial(_dispatch, _document_get)
search = functools.partial(_dispatch, _search)
