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

from mirage.accessor.linear import LinearAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.linear.client import (get_issue, list_issue_comments,
                                       list_team_cycles, list_team_documents,
                                       list_team_issues, list_team_members,
                                       list_team_projects, list_teams)
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_document, normalize_issue,
                                          normalize_project, normalize_team,
                                          normalize_user, project_issue_rows,
                                          to_json_bytes)
from mirage.core.linear.scope import detect_scope
from mirage.core.render.json import jsonl_bytes_by_created_at
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def _read_team_json(accessor: LinearAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    team_id = match.slots["team_id"]
    teams = await list_teams(accessor.config, session=accessor.pool)
    if accessor.config.team_ids:
        teams = [
            team for team in teams
            if team.get("id") in accessor.config.team_ids
        ]
    for team in teams:
        if team.get("id") == team_id:
            return to_json_bytes(normalize_team(team))
    raise enoent(path.virtual)


async def _read_member(accessor: LinearAccessor, match: ScopeMatch,
                       path: PathSpec, index: IndexCacheStore) -> bytes:
    member_id = match.slots["member_id"]
    users = await list_team_members(accessor.config,
                                    match.slots["team_id"],
                                    session=accessor.pool)
    for user in users:
        if user.get("id") == member_id:
            return to_json_bytes(normalize_user(user))
    raise enoent(path.virtual)


async def _read_issue_json(accessor: LinearAccessor, match: ScopeMatch,
                           path: PathSpec, index: IndexCacheStore) -> bytes:
    issue = await get_issue(accessor.config,
                            match.slots["issue_id"],
                            session=accessor.pool)
    return to_json_bytes(normalize_issue(issue))


async def _read_comments(accessor: LinearAccessor, match: ScopeMatch,
                         path: PathSpec, index: IndexCacheStore) -> bytes:
    issue_id = match.slots["issue_id"]
    issue = await get_issue(accessor.config, issue_id, session=accessor.pool)
    norm_issue = normalize_issue(issue)
    comments = await list_issue_comments(accessor.config,
                                         issue_id,
                                         session=accessor.pool)
    rows = [
        normalize_comment(comment,
                          issue_id=issue_id,
                          issue_key=norm_issue.get("issue_key"))
        for comment in comments
    ]
    return jsonl_bytes_by_created_at(rows)


async def _read_project(accessor: LinearAccessor, match: ScopeMatch,
                        path: PathSpec, index: IndexCacheStore) -> bytes:
    team_id = match.slots["team_id"]
    project_id = match.slots["project_id"]
    teams = await list_teams(accessor.config, session=accessor.pool)
    team = next((item for item in teams if item.get("id") == team_id), {})
    projects = await list_team_projects(accessor.config,
                                        team_id,
                                        session=accessor.pool)
    team_issues = await list_team_issues(accessor.config,
                                         team_id,
                                         session=accessor.pool)
    for project in projects:
        if project.get("id") == project_id:
            project_issues = project_issue_rows(team_issues, project_id)
            return to_json_bytes(
                normalize_project(
                    project,
                    team_id=team_id,
                    team_key=team.get("key"),
                    team_name=team.get("name"),
                    issues=project_issues,
                ))
    raise enoent(path.virtual)


async def _read_cycle(accessor: LinearAccessor, match: ScopeMatch,
                      path: PathSpec, index: IndexCacheStore) -> bytes:
    team_id = match.slots["team_id"]
    cycles = await list_team_cycles(accessor.config,
                                    team_id,
                                    session=accessor.pool)
    for cycle in cycles:
        if cycle.get("id") == match.slots["cycle_id"]:
            return to_json_bytes(normalize_cycle(cycle, team_id=team_id))
    raise enoent(path.virtual)


async def _read_document(accessor: LinearAccessor, match: ScopeMatch,
                         path: PathSpec, index: IndexCacheStore) -> bytes:
    documents = await list_team_documents(accessor.config,
                                          match.slots["team_id"],
                                          session=accessor.pool)
    for document in documents:
        if document.get("id") == match.slots["document_id"]:
            return to_json_bytes(normalize_document(document))
    raise enoent(path.virtual)


read = make_read(
    detect_scope,
    readers={
        "team_json": _read_team_json,
        "member": _read_member,
        "issue_json": _read_issue_json,
        "comments_jsonl": _read_comments,
        "project": _read_project,
        "cycle": _read_cycle,
        "document": _read_document,
    },
)
