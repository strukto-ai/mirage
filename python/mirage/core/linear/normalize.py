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

from mirage.utils.records import (
    as_object,
    pick_bool_or_none,
    pick_number_or_none,
    pick_string,
    records,
    string_of,
)


def normalize_team(team: dict[str, Any]) -> dict[str, Any]:
    states = []
    for state in records(as_object(team.get("states")).get("nodes", [])):
        states.append(
            {
                "state_id": pick_string(state, "id"),
                "state_name": pick_string(state, "name"),
                "type": pick_string(state, "type"),
            }
        )
    return {
        "team_id": pick_string(team, "id"),
        "team_key": pick_string(team, "key"),
        "team_name": pick_string(team, "name"),
        "name": pick_string(team, "name"),
        "description": pick_string(team, "description"),
        "timezone": pick_string(team, "timezone"),
        "updated_at": pick_string(team, "updatedAt"),
        "states": states,
    }


def normalize_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": pick_string(user, "id"),
        "name": pick_string(user, "name"),
        "display_name": pick_string(user, "displayName", "name"),
        "email": pick_string(user, "email"),
        "is_active": pick_bool_or_none(user, "active"),
        "is_admin": pick_bool_or_none(user, "admin"),
        "updated_at": pick_string(user, "updatedAt"),
        "url": pick_string(user, "url"),
    }


def normalize_issue(issue: dict[str, Any]) -> dict[str, Any]:
    team = as_object(issue.get("team"))
    state = as_object(issue.get("state"))
    project = as_object(issue.get("project"))
    cycle = as_object(issue.get("cycle"))
    assignee = as_object(issue.get("assignee"))
    creator = as_object(issue.get("creator"))
    labels = records(as_object(issue.get("labels")).get("nodes", []))
    return {
        "issue_id": pick_string(issue, "id"),
        "issue_key": pick_string(issue, "identifier"),
        "title": pick_string(issue, "title"),
        "description": string_of(issue, "description"),
        "team_id": pick_string(team, "id"),
        "team_key": pick_string(team, "key"),
        "team_name": pick_string(team, "name"),
        "project_id": pick_string(project, "id"),
        "project_name": pick_string(project, "name"),
        "cycle_id": pick_string(cycle, "id"),
        "cycle_name": pick_string(cycle, "name"),
        "cycle_number": pick_number_or_none(cycle, "number"),
        "state_id": pick_string(state, "id"),
        "state_name": pick_string(state, "name"),
        "assignee_id": pick_string(assignee, "id"),
        "assignee_email": pick_string(assignee, "email"),
        "assignee_name": pick_string(assignee, "name"),
        "creator_id": pick_string(creator, "id"),
        "creator_email": pick_string(creator, "email"),
        "creator_name": pick_string(creator, "name"),
        "priority": pick_number_or_none(issue, "priority"),
        "label_ids": [pick_string(label, "id") for label in labels],
        "label_names": [pick_string(label, "name") for label in labels],
        "created_at": pick_string(issue, "createdAt"),
        "updated_at": pick_string(issue, "updatedAt"),
        "url": pick_string(issue, "url"),
    }


def normalize_comment(
    comment: dict[str, Any], *, issue_id: str, issue_key: str | None
) -> dict[str, Any]:
    user = as_object(comment.get("user"))
    return {
        "comment_id": pick_string(comment, "id"),
        "issue_id": issue_id,
        "issue_key": issue_key,
        "user_id": pick_string(user, "id"),
        "user_email": pick_string(user, "email"),
        "user_name": pick_string(user, "displayName", "name"),
        "body": string_of(comment, "body"),
        "created_at": pick_string(comment, "createdAt"),
        "updated_at": pick_string(comment, "updatedAt"),
        "url": pick_string(comment, "url"),
    }


def normalize_project(
    project: dict[str, Any],
    *,
    team_id: str,
    team_key: str | None,
    team_name: str | None,
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    lead = as_object(project.get("lead"))
    return {
        "project_id": pick_string(project, "id"),
        "team_id": team_id,
        "team_key": team_key,
        "team_name": team_name,
        "name": pick_string(project, "name"),
        "description": pick_string(project, "description"),
        "state": pick_string(as_object(project.get("status")), "type"),
        "lead_id": pick_string(lead, "id"),
        "updated_at": pick_string(project, "updatedAt"),
        "url": pick_string(project, "url"),
        "issue_count": len(issues),
        "issues": issues,
    }


def project_issue_rows(
    issues: list[dict[str, Any]], project_id: str | None
) -> list[dict[str, Any]]:
    rows = []
    for issue in issues:
        if pick_string(as_object(issue.get("project")), "id") != project_id:
            continue
        state = as_object(issue.get("state"))
        rows.append(
            {
                "issue_id": pick_string(issue, "id"),
                "issue_key": pick_string(issue, "identifier"),
                "title": pick_string(issue, "title"),
                "state_id": pick_string(state, "id"),
                "state_name": pick_string(state, "name"),
                "url": pick_string(issue, "url"),
            }
        )
    return rows


def normalize_label(label: dict[str, Any]) -> dict[str, Any]:
    return {
        "label_id": pick_string(label, "id"),
        "name": pick_string(label, "name"),
        "color": pick_string(label, "color"),
    }


def normalize_document(document: dict[str, Any]) -> dict[str, Any]:
    project = as_object(document.get("project"))
    creator = as_object(document.get("creator"))
    return {
        "document_id": pick_string(document, "id"),
        "title": pick_string(document, "title"),
        "content": string_of(document, "content"),
        "project_id": pick_string(project, "id"),
        "project_name": pick_string(project, "name"),
        "creator_id": pick_string(creator, "id"),
        "creator_name": pick_string(creator, "name"),
        "creator_email": pick_string(creator, "email"),
        "created_at": pick_string(document, "createdAt"),
        "updated_at": pick_string(document, "updatedAt"),
        "url": pick_string(document, "url"),
    }


def normalize_cycle(cycle: dict[str, Any], *, team_id: str) -> dict[str, Any]:
    return {
        "cycle_id": pick_string(cycle, "id"),
        "team_id": team_id,
        "name": pick_string(cycle, "name"),
        "number": pick_number_or_none(cycle, "number"),
        "starts_at": pick_string(cycle, "startsAt"),
        "ends_at": pick_string(cycle, "endsAt"),
        "updated_at": pick_string(cycle, "updatedAt"),
        "url": pick_string(cycle, "url"),
    }


# The fields of an issue's JSON Linear's issue search reads; every other
# field is checked against the listing instead (``unsearched_text``).
SEARCHED_FIELDS = ("title", "description")
