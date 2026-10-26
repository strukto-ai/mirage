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

from typing import Any

from mirage.accessor.linear import LinearAccessor
from mirage.core.hierarchy.readdir import Listed, cut_listing, make_readdir
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.stat import entry_stat
from mirage.core.linear.client import (
    list_issue_comments,
    list_team_cycles,
    list_team_documents,
    list_team_issues,
    list_team_members,
    list_team_projects,
    list_teams,
)
from mirage.core.linear.normalize import (
    normalize_comment,
    normalize_cycle,
    normalize_document,
    normalize_issue,
    normalize_project,
    normalize_team,
    normalize_user,
    project_issue_rows,
    to_json_bytes,
    unsearched_text,
)
from mirage.core.linear.pathing import (
    cycle_filename,
    document_filename,
    issue_dirname,
    member_filename,
    project_filename,
    team_dirname,
)
from mirage.core.linear.scope import detect_scope
from mirage.core.render.json import jsonl_bytes_by_created_at
from mirage.types import ContentType, FileStat, FileType
from mirage.utils.record_search import kept_text

TEAM_DIRS = ("members", "issues", "projects", "cycles", "documents")


async def filtered_teams(accessor: LinearAccessor) -> list[dict[str, Any]]:
    """The teams the mount shows: all of them, or those in ``team_ids``.

    Args:
        accessor (LinearAccessor): linear accessor.
    """
    teams = await list_teams(accessor)
    if not accessor.config.team_ids:
        return teams
    return [
        team for team in teams if team.get("id") in accessor.config.team_ids
    ]


TEAM = entry_stat("team_id", FileType.DIRECTORY)
TEAM_JSON = entry_stat("team_id", ContentType.JSON)
MEMBER = entry_stat("member_id", ContentType.JSON)
ISSUE = entry_stat("issue_id", FileType.DIRECTORY)
ISSUE_JSON = entry_stat("issue_id", ContentType.JSON)
COMMENTS = entry_stat("issue_id", ContentType.TEXT)
PROJECT = entry_stat("project_id", ContentType.JSON)
CYCLE = entry_stat("cycle_id", ContentType.JSON)
DOCUMENT = entry_stat("document_id", ContentType.JSON)


async def _list_teams_dir(
    accessor: LinearAccessor, match: ScopeMatch
) -> list[FileStat]:
    # team.json renders the team object this listing already fetched,
    # so its exact size rides the directory's row, and the key/name
    # ride along for the project renders below it.
    return [
        TEAM(
            team_dirname(team),
            team["id"],
            modified=team.get("updatedAt"),
            extra={
                "team_key": team.get("key"),
                "team_name": team.get("name"),
                "json_size": len(to_json_bytes(normalize_team(team))),
            },
        )
        for team in await filtered_teams(accessor)
    ]


async def _list_team(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    team_id = match.slots["team_id"]
    rows = [
        TEAM_JSON(
            "team.json",
            team_id,
            size=entry.extra.get("json_size"),
            modified=entry.modified,
        )
    ]
    for name in TEAM_DIRS:
        extra = {}
        if name == "projects":
            # A project render carries its team's key and name, which only
            # the team listing knows.
            extra = {
                "team_key": entry.extra.get("team_key"),
                "team_name": entry.extra.get("team_name"),
            }
        rows.append(FileStat(name=name, type=FileType.DIRECTORY, extra=extra))
    return rows


async def _list_members(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> Listed:
    users = await list_team_members(
        accessor, match.slots["team_id"], match.limit
    )
    rows = []
    for user in users:
        rendered = to_json_bytes(normalize_user(user))
        rows.append(
            MEMBER(
                member_filename(user),
                user["id"],
                size=len(rendered),
                modified=user.get("updatedAt"),
                extra=kept_text(rendered),
            )
        )
    return cut_listing(rows, match.limit)


async def _list_issues(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> Listed:
    issues = await list_team_issues(
        accessor, match.slots["team_id"], match.limit
    )
    rows = []
    for issue in issues:
        extra: dict[str, Any] = {
            "issue_key": issue.get("identifier"),
            "json_size": len(to_json_bytes(normalize_issue(issue))),
        }
        if accessor.capped():
            extra["unsearched"] = unsearched_text(issue)
        rows.append(
            ISSUE(
                issue_dirname(issue),
                issue["id"],
                modified=issue.get("updatedAt"),
                extra=extra,
            )
        )
    return cut_listing(rows, match.limit)


async def _list_issue(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> list[FileStat]:
    # issue.json renders the issue the team listing already fetched;
    # comments.jsonl costs the one bounded comments call, paid only when
    # this directory is entered.
    issue_id = match.slots["issue_id"]
    comments = await list_issue_comments(accessor, issue_id)
    rendered = [
        normalize_comment(
            comment, issue_id=issue_id, issue_key=entry.extra.get("issue_key")
        )
        for comment in comments
    ]
    comments_time = max(
        (row.get("updated_at") or "" for row in rendered), default=""
    )
    return [
        ISSUE_JSON(
            "issue.json",
            issue_id,
            size=entry.extra.get("json_size"),
            modified=entry.modified,
        ),
        COMMENTS(
            "comments.jsonl",
            issue_id,
            size=len(jsonl_bytes_by_created_at(rendered)),
            modified=comments_time or entry.modified,
        ),
    ]


async def _list_projects(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> Listed:
    team_id = match.slots["team_id"]
    projects = await list_team_projects(accessor, team_id, match.limit)
    team_issues = await list_team_issues(
        accessor,
        team_id,
        projects=[str(project["id"]) for project in projects],
    )
    rows = []
    for project in projects:
        rendered = to_json_bytes(
            normalize_project(
                project,
                team_id=team_id,
                team_key=entry.extra.get("team_key"),
                team_name=entry.extra.get("team_name"),
                issues=project_issue_rows(team_issues, project.get("id")),
            )
        )
        rows.append(
            PROJECT(
                project_filename(project),
                project["id"],
                size=len(rendered),
                modified=project.get("updatedAt"),
                extra=kept_text(rendered),
            )
        )
    return cut_listing(rows, match.limit)


async def _list_cycles(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> Listed:
    team_id = match.slots["team_id"]
    cycles = await list_team_cycles(accessor, team_id, match.limit)
    rows = []
    for cycle in cycles:
        rendered = to_json_bytes(normalize_cycle(cycle, team_id=team_id))
        rows.append(
            CYCLE(
                cycle_filename(cycle),
                cycle["id"],
                size=len(rendered),
                modified=cycle.get("updatedAt"),
                extra=kept_text(rendered),
            )
        )
    return cut_listing(rows, match.limit)


async def _list_documents(
    accessor: LinearAccessor, match: ScopeMatch, entry: FileStat
) -> Listed:
    documents = await list_team_documents(
        accessor, match.slots["team_id"], match.limit
    )
    rows = []
    for document in documents:
        rendered = to_json_bytes(normalize_document(document))
        rows.append(
            DOCUMENT(
                document_filename(document),
                document["id"],
                size=len(rendered),
                modified=document.get("updatedAt"),
                extra=kept_text(rendered),
            )
        )
    return cut_listing(rows, match.limit)


readdir = make_readdir(
    detect_scope,
    listers={
        "teams": _list_teams_dir,
    },
    entry_listers={
        "team": _list_team,
        "members": _list_members,
        "issues": _list_issues,
        "issue": _list_issue,
        "projects": _list_projects,
        "cycles": _list_cycles,
        "documents": _list_documents,
    },
    static_root=("teams",),
)
