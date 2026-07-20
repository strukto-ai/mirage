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

from mirage.utils.naming import parse_id_name
from mirage.utils.sanitize import sanitize_name

split_suffix_id = parse_id_name


def team_dirname(team: dict[str, Any]) -> str:
    parts: list[str] = []
    if team.get("key"):
        parts.append(sanitize_name(team["key"]))
    if team.get("name"):
        sanitized_name = sanitize_name(team["name"])
        if sanitized_name not in parts:
            parts.append(sanitized_name)
    if not parts:
        parts.append("team")
    return f"{'__'.join(parts)}__{team['id']}"


def member_filename(user: dict[str, Any]) -> str:
    label = sanitize_name(
        user.get("displayName") or user.get("name") or user.get("email")
        or "user")
    return f"{label}__{user['id']}.json"


def issue_dirname(issue: dict[str, Any]) -> str:
    key = issue.get("identifier") or issue.get("id") or "issue"
    return f"{sanitize_name(key)}__{issue['id']}"


def project_filename(project: dict[str, Any]) -> str:
    label = sanitize_name(project.get("name") or "project")
    return f"{label}__{project['id']}.json"


def cycle_filename(cycle: dict[str, Any]) -> str:
    label = sanitize_name(cycle.get("name") or "cycle")
    return f"{label}__{cycle['id']}.json"


def document_filename(document: dict[str, Any]) -> str:
    label = sanitize_name(document.get("title") or "document")
    return f"{label}__{document['id']}.json"
