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

try:
    from google.antigravity import (
        BuiltinTools,
        CapabilitiesConfig,
        LocalAgentConfig,
    )
except ImportError as exc:
    raise ImportError(
        "`google-antigravity` not installed. "
        "Install with: pip install google-antigravity"
    ) from exc

from mirage.agents.antigravity.tools import mirage_tools
from mirage.agents.prompt import build_system_prompt
from mirage.workspace.workspace import Workspace


async def build_config(
    workspace: Workspace,
    *,
    system_prompt: str | None = None,
    session_id: str | None = None,
) -> LocalAgentConfig:
    """Build a LocalAgentConfig backed by a Mirage Workspace.

    Turns off the harness's own tools but ``finish``, and registers
    Mirage tools (shell, read, write, edit, ls, grep, glob) as the
    agent's only file access layer. Subagents are off too, since a
    subagent would get the harness's own file and shell tools back. The
    prompt is added to the harness's own instructions, not put in their
    place.

    Args:
        workspace (Workspace): The workspace to serve.
        system_prompt (str | None): Override the default Mirage system prompt.
        session_id (str | None): Bind the tools and prompt to this session.

    Returns:
        LocalAgentConfig: Ready to pass to google.antigravity.Agent.
    """
    return LocalAgentConfig(
        tools=mirage_tools(workspace, session_id=session_id),
        capabilities=CapabilitiesConfig(
            enabled_tools=[BuiltinTools.FINISH],
            enable_subagents=False,
        ),
        system_instructions=system_prompt
        or await build_system_prompt(
            workspace=workspace, session_id=session_id
        ),
    )
