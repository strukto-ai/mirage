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
from typing import Any


def normalize_team(team: dict[str, Any]) -> dict[str, Any]:
    states = []
    for state in (team.get("states") or {}).get("nodes", []):
        states.append({
            "state_id": state.get("id"),
            "state_name": state.get("name"),
            "type": state.get("type"),
        })
    return {
        "team_id": team.get("id"),
        "team_key": team.get("key"),
        "team_name": team.get("name"),
        "name": team.get("name"),
        "description": team.get("description"),
        "timezone": team.get("timezone"),
        "updated_at": team.get("updatedAt"),
        "states": states,
    }


def normalize_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": user.get("id"),
        "name": user.get("name"),
        "display_name": user.get("displayName") or user.get("name"),
        "email": user.get("email"),
        "is_active": user.get("active"),
        "is_admin": user.get("admin"),
        "updated_at": user.get("updatedAt"),
        "url": user.get("url"),
    }


def normalize_issue(issue: dict[str, Any]) -> dict[str, Any]:
    team = issue.get("team") or {}
    state = issue.get("state") or {}
    project = issue.get("project") or {}
    cycle = issue.get("cycle") or {}
    assignee = issue.get("assignee") or {}
    creator = issue.get("creator") or {}
    labels = (issue.get("labels") or {}).get("nodes", [])
    return {
        "issue_id": issue.get("id"),
        "issue_key": issue.get("identifier"),
        "title": issue.get("title"),
        "description": issue.get("description") or "",
        "team_id": team.get("id"),
        "team_key": team.get("key"),
        "team_name": team.get("name"),
        "project_id": project.get("id"),
        "project_name": project.get("name"),
        "cycle_id": cycle.get("id"),
        "cycle_name": cycle.get("name"),
        "cycle_number": cycle.get("number"),
        "state_id": state.get("id"),
        "state_name": state.get("name"),
        "assignee_id": assignee.get("id"),
        "assignee_email": assignee.get("email"),
        "assignee_name": assignee.get("name"),
        "creator_id": creator.get("id"),
        "creator_email": creator.get("email"),
        "creator_name": creator.get("name"),
        "priority": issue.get("priority"),
        "label_ids": [label.get("id") for label in labels],
        "label_names": [label.get("name") for label in labels],
        "created_at": issue.get("createdAt"),
        "updated_at": issue.get("updatedAt"),
        "url": issue.get("url"),
    }


def normalize_comment(comment: dict[str, Any], *, issue_id: str,
                      issue_key: str | None) -> dict[str, Any]:
    user = comment.get("user") or {}
    return {
        "comment_id": comment.get("id"),
        "issue_id": issue_id,
        "issue_key": issue_key,
        "user_id": user.get("id"),
        "user_email": user.get("email"),
        "user_name": user.get("displayName") or user.get("name"),
        "body": comment.get("body") or "",
        "created_at": comment.get("createdAt"),
        "updated_at": comment.get("updatedAt"),
        "url": comment.get("url"),
    }


def normalize_project(
    project: dict[str, Any],
    *,
    team_id: str,
    team_key: str | None,
    team_name: str | None,
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    lead = project.get("lead") or {}
    return {
        "project_id": project.get("id"),
        "team_id": team_id,
        "team_key": team_key,
        "team_name": team_name,
        "name": project.get("name"),
        "description": project.get("description"),
        "state": (project.get("status") or {}).get("type"),
        "lead_id": lead.get("id"),
        "updated_at": project.get("updatedAt"),
        "url": project.get("url"),
        "issue_count": len(issues),
        "issues": issues,
    }


def normalize_label(label: dict[str, Any]) -> dict[str, Any]:
    return {
        "label_id": label.get("id"),
        "name": label.get("name"),
        "color": label.get("color"),
    }


def normalize_document(document: dict[str, Any]) -> dict[str, Any]:
    project = document.get("project") or {}
    creator = document.get("creator") or {}
    return {
        "document_id": document.get("id"),
        "title": document.get("title"),
        "content": document.get("content") or "",
        "project_id": project.get("id"),
        "project_name": project.get("name"),
        "creator_id": creator.get("id"),
        "creator_name": creator.get("name"),
        "creator_email": creator.get("email"),
        "created_at": document.get("createdAt"),
        "updated_at": document.get("updatedAt"),
        "url": document.get("url"),
    }


def normalize_cycle(cycle: dict[str, Any], *, team_id: str) -> dict[str, Any]:
    return {
        "cycle_id": cycle.get("id"),
        "team_id": team_id,
        "name": cycle.get("name"),
        "number": cycle.get("number"),
        "starts_at": cycle.get("startsAt"),
        "ends_at": cycle.get("endsAt"),
        "updated_at": cycle.get("updatedAt"),
        "url": cycle.get("url"),
    }


def to_json_bytes(value: dict[str, Any] | list[Any]) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode()


def to_jsonl_bytes(rows: list[dict[str, Any]]) -> bytes:
    ordered = sorted(rows, key=lambda row: row.get("created_at") or "")
    if not ordered:
        return b""
    text = "\n".join(
        json.dumps(row, ensure_ascii=False, separators=(",", ":"))
        for row in ordered)
    return text.encode() + b"\n"
