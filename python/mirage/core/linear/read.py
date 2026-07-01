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
from mirage.core.linear._client import (get_issue, list_issue_comments,
                                        list_team_cycles, list_team_issues,
                                        list_team_members, list_team_projects,
                                        list_teams)
from mirage.core.linear.normalize import (normalize_comment, normalize_cycle,
                                          normalize_issue, normalize_project,
                                          normalize_team, normalize_user,
                                          to_json_bytes, to_jsonl_bytes)
from mirage.core.linear.pathing import split_suffix_id
from mirage.resource.linear.config import LinearConfig
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(
    config: LinearConfig,
    path: PathSpec,
    virtual: str,
) -> bytes:
    key = path.strip("/")
    parts = key.split("/")

    if len(parts) == 3 and parts[0] == "teams" and parts[2] == "team.json":
        _, team_id = split_suffix_id(parts[1])
        teams = await list_teams(config)
        if config.team_ids:
            teams = [
                team for team in teams if team.get("id") in config.team_ids
            ]
        for team in teams:
            if team.get("id") == team_id:
                return to_json_bytes(normalize_team(team))
        raise enoent(virtual)

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "members":
        _, team_id = split_suffix_id(parts[1])
        _, user_id = split_suffix_id(parts[3], suffix=".json")
        users = await list_team_members(config, team_id)
        for user in users:
            if user.get("id") == user_id:
                return to_json_bytes(normalize_user(user))
        raise enoent(virtual)

    if len(parts) == 5 and parts[0] == "teams" and parts[2] == "issues":
        _, issue_id = split_suffix_id(parts[3])
        issue = await get_issue(config, issue_id)
        if parts[4] == "issue.json":
            return to_json_bytes(normalize_issue(issue))
        if parts[4] == "comments.jsonl":
            norm_issue = normalize_issue(issue)
            comments = await list_issue_comments(config, issue_id)
            rows = [
                normalize_comment(comment,
                                  issue_id=issue_id,
                                  issue_key=norm_issue.get("issue_key"))
                for comment in comments
            ]
            return to_jsonl_bytes(rows)
        raise enoent(virtual)

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "projects":
        _, team_id = split_suffix_id(parts[1])
        _, project_id = split_suffix_id(parts[3], suffix=".json")
        teams = await list_teams(config)
        team = next((item for item in teams if item.get("id") == team_id), {})
        projects = await list_team_projects(config, team_id)
        team_issues = await list_team_issues(config, team_id)
        for project in projects:
            if project.get("id") == project_id:
                project_issues = []
                for issue in team_issues:
                    if (issue.get("project") or {}).get("id") != project_id:
                        continue
                    state = issue.get("state") or {}
                    project_issues.append({
                        "issue_id": issue.get("id"),
                        "issue_key": issue.get("identifier"),
                        "title": issue.get("title"),
                        "state_id": state.get("id"),
                        "state_name": state.get("name"),
                        "url": issue.get("url"),
                    })
                return to_json_bytes(
                    normalize_project(
                        project,
                        team_id=team_id,
                        team_key=team.get("key"),
                        team_name=team.get("name"),
                        issues=project_issues,
                    ))
        raise enoent(virtual)

    if len(parts) == 4 and parts[0] == "teams" and parts[2] == "cycles":
        _, team_id = split_suffix_id(parts[1])
        _, cycle_id = split_suffix_id(parts[3], suffix=".json")
        cycles = await list_team_cycles(config, team_id)
        for cycle in cycles:
            if cycle.get("id") == cycle_id:
                return to_json_bytes(normalize_cycle(cycle, team_id=team_id))
        raise enoent(virtual)

    raise enoent(virtual)


async def read(
    accessor: LinearAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    if isinstance(path, PathSpec):
        path = path.strip_prefix

    return await read_bytes(accessor.config, path, virtual)
