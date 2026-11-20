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

try:
    from google.antigravity import ToolExecutionError
    from google.antigravity.tools.tool_runner import ToolWithSchema
except ImportError as exc:
    raise ImportError(
        "`google-antigravity` not installed. "
        "Install with: pip install google-antigravity"
    ) from exc

from mirage.workspace.tools.tool_descriptions import (
    EDIT_DESCRIPTION,
    EDIT_INPUT,
    GLOB_DESCRIPTION,
    GLOB_INPUT,
    GREP_DESCRIPTION,
    GREP_INPUT,
    LS_DESCRIPTION,
    LS_INPUT,
    READ_DESCRIPTION,
    READ_INPUT,
    SHELL_DESCRIPTION,
    SHELL_INPUT,
    WRITE_DESCRIPTION,
    WRITE_INPUT,
)
from mirage.workspace.tools.tool_operations import MirageToolOperations
from mirage.workspace.workspace import Session, Workspace


def _tool(
    ops: MirageToolOperations,
    name: str,
    description: str,
    schema: dict[str, Any],
) -> ToolWithSchema:
    """One Mirage tool as the Antigravity SDK takes a tool: a callable
    with its name, description and JSON schema.

    Args:
        ops (MirageToolOperations): the session's tool operations.
        name (str): the tool's name, as the agent calls it.
        description (str): what the agent is told the tool does.
        schema (dict[str, Any]): the tool's input as JSON schema.
    """

    async def run(**args: Any) -> str:
        result = await ops.call(name, args)
        if result.is_error:
            raise ToolExecutionError(result.text, tool_name=name)
        return result.text

    run.__name__ = name
    run.__doc__ = description
    return ToolWithSchema(run, schema)


def mirage_tools(
    workspace: Workspace,
    stale_write_protection: bool = True,
    session_id: str | None = None,
) -> list[ToolWithSchema]:
    """Mirage's agent tools for an Antigravity agent, the ones the
    session's profile leaves it.

    Args:
        workspace (Workspace): the workspace to serve.
        stale_write_protection (bool): False lets an agent overwrite a
            file that changed since it read it.
        session_id (str | None): the session the tools act as, with its
            profile; None is the workspace's default session.

    Returns:
        list[ToolWithSchema]: ready to pass to
            LocalAgentConfig(tools=...).
    """
    session = Session(workspace, session_id)
    ops = (
        session.tools
        if stale_write_protection
        else MirageToolOperations(session, stale_write_protection=False)
    )
    names = ops.names()
    return [
        _tool(ops, name, description, schema)
        for name, description, schema in (
            ("shell", SHELL_DESCRIPTION, SHELL_INPUT),
            ("read", READ_DESCRIPTION, READ_INPUT),
            ("write", WRITE_DESCRIPTION, WRITE_INPUT),
            ("edit", EDIT_DESCRIPTION, EDIT_INPUT),
            ("ls", LS_DESCRIPTION, LS_INPUT),
            ("grep", GREP_DESCRIPTION, GREP_INPUT),
            ("glob", GLOB_DESCRIPTION, GLOB_INPUT),
        )
        if name in names
    ]
