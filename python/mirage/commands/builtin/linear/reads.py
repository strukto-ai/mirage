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
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from mirage.accessor.linear import LinearAccessor
from mirage.commands.registry import command
from mirage.commands.spec.types import (CommandSpec, FlagView, Operand,
                                        OperandKind, Option)
from mirage.core.linear._client import (get_issue, list_issue_comments,
                                        list_team_cycles, list_team_documents,
                                        list_team_issues, list_team_labels,
                                        list_team_members, list_team_projects,
                                        list_teams, resolve_issue_id,
                                        resolve_team, search_issues)
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_document, normalize_issue,
                                          normalize_label, normalize_project,
                                          normalize_team, normalize_user,
                                          to_json_bytes)
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec

ISSUE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-\d+$")

Runner = Callable[[LinearAccessor, list[str], FlagView], Awaitable[bytes]]


@dataclass(frozen=True, slots=True)
class LinearRead:
    name: str
    runner: Runner
    spec: CommandSpec


SPEC_NONE = CommandSpec()
SPEC_ARG = CommandSpec(rest=Operand(kind=OperandKind.TEXT))
SPEC_TEAM = CommandSpec(options=(Option(long="--team",
                                        value_kind=OperandKind.TEXT), ), )
SPEC_TEAM_ARG = CommandSpec(
    options=(Option(long="--team", value_kind=OperandKind.TEXT), ),
    rest=Operand(kind=OperandKind.TEXT),
)


def _first(texts: list[str], label: str) -> str:
    if not texts:
        raise ValueError(f"{label} is required")
    return texts[0]


def _require_team(fl: FlagView) -> str:
    team = fl.as_str("team")
    if not team:
        raise ValueError("--team is required")
    return team


async def _resolve_issue(config: LinearConfig, token: str) -> str:
    if ISSUE_KEY_RE.match(token):
        return await resolve_issue_id(config, issue_key=token)
    return token


async def _project_issue_rows(config: LinearConfig, team_id: str,
                              project_id: str) -> list[dict[str, object]]:
    team_issues = await list_team_issues(config, team_id)
    rows: list[dict[str, object]] = []
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


async def _run_team_list(accessor: LinearAccessor, texts: list[str],
                         fl: FlagView) -> bytes:
    config = accessor.config
    teams = await list_teams(config)
    if config.team_ids:
        teams = [t for t in teams if t.get("id") in config.team_ids]
    return to_json_bytes([normalize_team(team) for team in teams])


async def _run_team_get(accessor: LinearAccessor, texts: list[str],
                        fl: FlagView) -> bytes:
    team = await resolve_team(accessor.config, _first(texts, "team key"))
    return to_json_bytes(normalize_team(team))


async def _run_team_members(accessor: LinearAccessor, texts: list[str],
                            fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _first(texts, "team key"))
    users = await list_team_members(config, team["id"])
    return to_json_bytes([normalize_user(user) for user in users])


async def _run_issue_list(accessor: LinearAccessor, texts: list[str],
                          fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    issues = await list_team_issues(config, team["id"])
    return to_json_bytes([normalize_issue(issue) for issue in issues])


async def _run_issue_get(accessor: LinearAccessor, texts: list[str],
                         fl: FlagView) -> bytes:
    config = accessor.config
    issue_id = await _resolve_issue(config, _first(texts, "issue key"))
    issue = await get_issue(config, issue_id)
    return to_json_bytes(normalize_issue(issue))


async def _run_project_list(accessor: LinearAccessor, texts: list[str],
                            fl: FlagView) -> bytes:
    config = accessor.config
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


async def _run_project_get(accessor: LinearAccessor, texts: list[str],
                           fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    project_id = _first(texts, "project id")
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


async def _run_cycle_list(accessor: LinearAccessor, texts: list[str],
                          fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    cycles = await list_team_cycles(config, team["id"])
    return to_json_bytes(
        [normalize_cycle(cycle, team_id=team["id"]) for cycle in cycles])


async def _run_cycle_current(accessor: LinearAccessor, texts: list[str],
                             fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    cycles = await list_team_cycles(config, team["id"])
    if not cycles:
        raise FileNotFoundError("no cycles")
    current = max(cycles, key=lambda cycle: cycle.get("number") or 0)
    return to_json_bytes(normalize_cycle(current, team_id=team["id"]))


async def _run_cycle_get(accessor: LinearAccessor, texts: list[str],
                         fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    cycle_id = _first(texts, "cycle id")
    cycles = await list_team_cycles(config, team["id"])
    for cycle in cycles:
        if cycle.get("id") == cycle_id:
            return to_json_bytes(normalize_cycle(cycle, team_id=team["id"]))
    raise FileNotFoundError(cycle_id)


async def _run_label_list(accessor: LinearAccessor, texts: list[str],
                          fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    labels = await list_team_labels(config, team["id"])
    return to_json_bytes([normalize_label(label) for label in labels])


async def _run_comment_list(accessor: LinearAccessor, texts: list[str],
                            fl: FlagView) -> bytes:
    config = accessor.config
    issue_id = await _resolve_issue(config, _first(texts, "issue key"))
    issue = await get_issue(config, issue_id)
    issue_key = issue.get("identifier")
    comments = await list_issue_comments(config, issue_id)
    return to_json_bytes([
        normalize_comment(comment, issue_id=issue_id, issue_key=issue_key)
        for comment in comments
    ])


async def _all_users(config: LinearConfig) -> list[dict[str, object]]:
    teams = await list_teams(config)
    seen: set[str] = set()
    users: list[dict[str, object]] = []
    for team in teams:
        for user in await list_team_members(config, team["id"]):
            uid = user.get("id")
            if not isinstance(uid, str) or uid in seen:
                continue
            seen.add(uid)
            users.append(user)
    return users


async def _run_user_list(accessor: LinearAccessor, texts: list[str],
                         fl: FlagView) -> bytes:
    users = await _all_users(accessor.config)
    return to_json_bytes([normalize_user(user) for user in users])


async def _run_user_get(accessor: LinearAccessor, texts: list[str],
                        fl: FlagView) -> bytes:
    email = _first(texts, "user email")
    for user in await _all_users(accessor.config):
        if user.get("email") == email:
            return to_json_bytes(normalize_user(user))
    raise FileNotFoundError(email)


async def _run_document_list(accessor: LinearAccessor, texts: list[str],
                             fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    documents = await list_team_documents(config, team["id"])
    return to_json_bytes(
        [normalize_document(document) for document in documents])


async def _run_document_get(accessor: LinearAccessor, texts: list[str],
                            fl: FlagView) -> bytes:
    config = accessor.config
    team = await resolve_team(config, _require_team(fl))
    document_id = _first(texts, "document id")
    documents = await list_team_documents(config, team["id"])
    for document in documents:
        if document.get("id") == document_id:
            return to_json_bytes(normalize_document(document))
    raise FileNotFoundError(document_id)


async def _run_search(accessor: LinearAccessor, texts: list[str],
                      fl: FlagView) -> bytes:
    query = fl.as_str("query") or (texts[0] if texts else None)
    if not query:
        raise ValueError("a search query is required")
    results = await search_issues(accessor.config, query)
    return to_json_bytes(results)


SEARCH_SPEC = CommandSpec(
    options=(Option(long="--query", value_kind=OperandKind.TEXT), ),
    rest=Operand(kind=OperandKind.TEXT),
)

LINEAR_READS: tuple[LinearRead, ...] = (
    LinearRead("linear team list", _run_team_list, SPEC_NONE),
    LinearRead("linear team get", _run_team_get, SPEC_ARG),
    LinearRead("linear team members", _run_team_members, SPEC_ARG),
    LinearRead("linear issue list", _run_issue_list, SPEC_TEAM),
    LinearRead("linear issue get", _run_issue_get, SPEC_ARG),
    LinearRead("linear project list", _run_project_list, SPEC_TEAM),
    LinearRead("linear project get", _run_project_get, SPEC_TEAM_ARG),
    LinearRead("linear cycle list", _run_cycle_list, SPEC_TEAM),
    LinearRead("linear cycle current", _run_cycle_current, SPEC_TEAM),
    LinearRead("linear cycle get", _run_cycle_get, SPEC_TEAM_ARG),
    LinearRead("linear label list", _run_label_list, SPEC_TEAM),
    LinearRead("linear comment list", _run_comment_list, SPEC_ARG),
    LinearRead("linear user list", _run_user_list, SPEC_NONE),
    LinearRead("linear user get", _run_user_get, SPEC_ARG),
    LinearRead("linear document list", _run_document_list, SPEC_TEAM),
    LinearRead("linear document get", _run_document_get, SPEC_TEAM_ARG),
    LinearRead("linear search", _run_search, SEARCH_SPEC),
)


async def _dispatch(
    entry: LinearRead,
    accessor: LinearAccessor,
    paths: list[PathSpec],
    *texts: str,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(flags, spec=entry.spec)
    data = await entry.runner(accessor, list(texts), fl)
    return yield_bytes(data), IOResult()


def make_linear_read_commands() -> list[Callable[..., object]]:
    commands: list[Callable[..., object]] = []
    for entry in LINEAR_READS:
        commands.append(
            command(entry.name, resource="linear",
                    spec=entry.spec)(functools.partial(_dispatch, entry)))
    return commands
