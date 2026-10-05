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

from dataclasses import KW_ONLY, dataclass

from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.tools import AgentDepsT
from pydantic_ai.workspaces import WorkspaceBackend, WorkspaceRef

from mirage.agents.pydantic_ai.backend import MirageWorkspaceBackend
from mirage.agents.pydantic_ai.constants import PROVIDER
from mirage.workspace.workspace import Workspace


@dataclass
class MirageWorkspace(AbstractCapability[AgentDepsT]):
    """Give runs a Mirage session as their workspace.

    Every tool that works in ``ctx.workspace`` then reaches the
    session's mounts: pydantic-ai-backend's ``ConsoleCapability``, or
    the harness's file and shell tools. A ref from message history only
    continues in the configured session: one naming another session is
    declined, and for the default session, whose id the session store
    may still adopt, the backend checks it on first use.

    Example:
        ```python
        from pydantic_ai import Agent
        from pydantic_ai_backends import ConsoleCapability

        agent = Agent(
            "anthropic:claude-opus-5-5",
            capabilities=[MirageWorkspace(ws), ConsoleCapability()],
        )
        ```

    Args:
        workspace (Workspace): The workspace runs work in.
        session_id (str | None): The session runs act as; None is the
            workspace's default session.
    """

    workspace: Workspace

    _: KW_ONLY

    session_id: str | None = None

    def get_workspace(
        self, ctx: RunContext[AgentDepsT], *, ref: WorkspaceRef | None
    ) -> WorkspaceBackend | None:
        if ref is not None and (
            ref.provider != PROVIDER
            or (self.session_id is not None and ref.id != self.session_id)
        ):
            return None
        return MirageWorkspaceBackend(self.workspace, self.session_id, ref=ref)
