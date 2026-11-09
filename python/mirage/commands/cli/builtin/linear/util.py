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

import re
from typing import cast

from mirage.accessor.linear import LinearAccessor
from mirage.commands.cli.operand import first_text
from mirage.commands.spec.flag_view import FlagView
from mirage.core.linear.client import (
    get_issue,
    list_team_labels,
    list_team_projects,
    list_teams,
    resolve_issue_id,
)
from mirage.io.types import ByteSource, materialize

ISSUE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-[0-9]+$")


async def resolve_issue(accessor: LinearAccessor, token: str) -> str:
    """Resolve an issue operand: an ENG-42 key or a raw ID.

    Args:
        accessor (LinearAccessor): the install's Linear handle.
        token (str): issue key or ID as typed.

    Returns:
        str: the issue's ID.
    """
    if ISSUE_KEY_RE.match(token):
        return await resolve_issue_id(accessor, issue_key=token)
    return token


async def resolve_state_id(
    accessor: LinearAccessor,
    state_id: str | None,
    state_name: str | None,
) -> str:
    """Resolve a workflow state from its ID or its display name.

    Args:
        accessor (LinearAccessor): the install's Linear handle.
        state_id (str | None): state ID, taken verbatim.
        state_name (str | None): state name, looked up across teams.

    Returns:
        str: the state's ID.
    """
    if state_id:
        return state_id
    if not state_name:
        raise ValueError("--state-id or --state-name is required")
    teams = await list_teams(accessor)
    for team in teams:
        for state in (team.get("states") or {}).get("nodes", []):
            if state.get("name") == state_name:
                return cast(str, state["id"])
    raise FileNotFoundError(state_name)


async def resolve_label_id(
    accessor: LinearAccessor,
    team_id: str,
    label_id: str | None,
    label_name: str | None,
) -> str:
    """Resolve a label from its ID or its display name.

    Args:
        accessor (LinearAccessor): the install's Linear handle.
        team_id (str): the issue's team, scoping the name lookup.
        label_id (str | None): label ID, taken verbatim.
        label_name (str | None): label name, looked up on the team.

    Returns:
        str: the label's ID.
    """
    if label_id:
        return label_id
    if not label_name:
        raise ValueError("--label or --label-name is required")
    for label in await list_team_labels(accessor, team_id):
        if label.get("name") == label_name:
            return cast(str, label["id"])
    raise FileNotFoundError(label_name)


async def issue_labels(
    accessor: LinearAccessor, texts: list[str], fl: FlagView
) -> tuple[str, list[str], str]:
    """Resolve what add-label and remove-label act on.

    Args:
        accessor (LinearAccessor): the install's Linear handle.
        texts (list[str]): the leaf's operands, the issue first.
        fl (FlagView): the leaf's flags, naming the label.

    Returns:
        tuple[str, list[str], str]: the issue's ID, its label IDs and
        the ID of the label the line names.
    """
    issue_id = await resolve_issue(accessor, first_text(texts, "issue key"))
    issue = await get_issue(accessor, issue_id)
    team_id = (issue.get("team") or {}).get("id") or ""
    label_id = await resolve_label_id(
        accessor, team_id, fl.as_str("label"), fl.as_str("label_name")
    )
    nodes = issue.get("labels", {}).get("nodes", [])
    return issue_id, [n["id"] for n in nodes], label_id


async def resolve_project_id(
    accessor: LinearAccessor,
    team_id: str,
    project_id: str | None,
    project_name: str | None,
) -> str:
    """Resolve a project from its ID or its display name.

    Args:
        accessor (LinearAccessor): the install's Linear handle.
        team_id (str): the issue's team, scoping the name lookup.
        project_id (str | None): project ID, taken verbatim.
        project_name (str | None): project name, looked up on the team.

    Returns:
        str: the project's ID.
    """
    if project_id:
        return project_id
    if not project_name:
        raise ValueError("--project or --project-name is required")
    for project in await list_team_projects(accessor, team_id):
        if project.get("name") == project_name:
            return cast(str, project["id"])
    raise FileNotFoundError(project_name)


async def text_or_stdin(
    inline_text: str | None,
    stdin: ByteSource | None,
    error_message: str,
) -> str:
    """Resolve free text from a flag with a stdin fallback.

    Args:
        inline_text (str | None): text given inline on the command line.
        stdin (ByteSource | None): piped input.
        error_message (str): raised when neither source provides text.

    Returns:
        str: the resolved text.
    """
    if inline_text:
        return inline_text
    if stdin is not None:
        raw = await materialize(stdin)
        # Piped text ends with the pipe's newline (echo body | ...);
        # the API body should not.
        return raw.decode(errors="replace").rstrip("\n")
    raise ValueError(error_message)
