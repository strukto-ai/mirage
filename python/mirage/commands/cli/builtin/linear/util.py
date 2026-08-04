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

from mirage.core.linear._client import (list_team_labels, list_team_projects,
                                        list_teams, resolve_issue_id)
from mirage.core.linear.config import LinearConfig
from mirage.io.types import ByteSource

ISSUE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*-\d+$")


def first_text(texts: tuple[str, ...], label: str) -> str:
    if not texts:
        raise ValueError(f"{label} is required")
    return texts[0]


async def resolve_issue(config: LinearConfig, token: str) -> str:
    """Resolve an issue operand: an ENG-42 key or a raw ID.

    Args:
        config (LinearConfig): Linear credentials.
        token (str): issue key or ID as typed.

    Returns:
        str: the issue's ID.
    """
    if ISSUE_KEY_RE.match(token):
        return await resolve_issue_id(config, issue_key=token)
    return token


async def resolve_state_id(
    config: LinearConfig,
    state_id: str | None,
    state_name: str | None,
) -> str:
    """Resolve a workflow state from its ID or its display name.

    Args:
        config (LinearConfig): Linear credentials.
        state_id (str | None): state ID, taken verbatim.
        state_name (str | None): state name, looked up across teams.

    Returns:
        str: the state's ID.
    """
    if state_id:
        return state_id
    if not state_name:
        raise ValueError("--state-id or --state-name is required")
    teams = await list_teams(config)
    for team in teams:
        for state in (team.get("states") or {}).get("nodes", []):
            if state.get("name") == state_name:
                return state["id"]
    raise FileNotFoundError(state_name)


async def resolve_label_id(
    config: LinearConfig,
    team_id: str,
    label_id: str | None,
    label_name: str | None,
) -> str:
    """Resolve a label from its ID or its display name.

    Args:
        config (LinearConfig): Linear credentials.
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
    for label in await list_team_labels(config, team_id):
        if label.get("name") == label_name:
            return label["id"]
    raise FileNotFoundError(label_name)


async def resolve_project_id(
    config: LinearConfig,
    team_id: str,
    project_id: str | None,
    project_name: str | None,
) -> str:
    """Resolve a project from its ID or its display name.

    Args:
        config (LinearConfig): Linear credentials.
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
    for project in await list_team_projects(config, team_id):
        if project.get("name") == project_name:
            return project["id"]
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
        if isinstance(stdin, bytes):
            raw = stdin
        else:
            chunks: list[bytes] = []
            async for chunk in stdin:
                chunks.append(chunk)
            raw = b"".join(chunks)
        # Piped text ends with the pipe's newline (echo body | ...);
        # the API body should not.
        return raw.decode(errors="replace").rstrip("\n")
    raise ValueError(error_message)
