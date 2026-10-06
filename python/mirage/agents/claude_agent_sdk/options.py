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
    from claude_agent_sdk import ClaudeAgentOptions
except ImportError as exc:
    raise ImportError(
        "`claude-agent-sdk` not installed. "
        "Install with: pip install 'mirage-ai[claude-agent-sdk]'"
    ) from exc

from mirage.agents.claude_agent_sdk.server import MirageServer
from mirage.agents.prompt import build_system_prompt
from mirage.workspace.workspace import Workspace


async def build_options(
    workspace: Workspace,
    *,
    system_prompt: str | None = None,
    session_id: str | None = None,
) -> ClaudeAgentOptions:
    """Build ClaudeAgentOptions backed by a Mirage Workspace.

    Disables all built-in file tools and registers Mirage tools
    (shell, read, write, edit, ls, grep, glob) as the agent's
    only file access layer.

    Args:
        workspace (Workspace): The workspace to serve.
        system_prompt (str | None): Override the default Mirage system prompt.
        session_id (str | None): Bind the tools and prompt to this session.

    Returns:
        ClaudeAgentOptions: Ready to pass to claude_agent_sdk.query().
    """
    server = MirageServer(workspace, session_id=session_id)
    return ClaudeAgentOptions(
        mcp_servers={"mirage": server},
        allowed_tools=["mcp__mirage__*"],
        tools=[],
        system_prompt=system_prompt
        or await build_system_prompt(
            workspace=workspace, session_id=session_id
        ),
    )
