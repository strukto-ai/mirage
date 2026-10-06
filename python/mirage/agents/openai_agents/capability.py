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

from typing import Literal

from agents.sandbox.capabilities import Capability
from agents.sandbox.manifest import Manifest
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.sandbox_session import SandboxSession

from mirage.agents.openai_agents.constants import (
    MOUNTS_INTRO,
    NOT_MIRAGE_SESSION,
)
from mirage.agents.openai_agents.sandbox import MirageSandboxSession


class MirageCapability(Capability):
    """Tell a SandboxAgent's model which Mirage mounts it is working in.

    The SDK describes the filesystem from its manifest alone, so the
    mounts behind a Mirage sandbox never reach the model. This adds the
    workspace's own mount listing (backend, mode, commands) to the
    agent's instructions. It binds only to a session from
    ``MirageSandboxClient``.
    """

    type: Literal["mirage"] = "mirage"

    def bind(self, session: BaseSandboxSession) -> None:
        mirage_session(session)
        super().bind(session)

    async def instructions(self, manifest: Manifest) -> str | None:
        session = mirage_session(self.session)
        markdown = await session.workspace.vfs_md(
            session_id=session.session_id
        )
        return f"{MOUNTS_INTRO}\n\n{markdown}"


def mirage_session(session: BaseSandboxSession | None) -> MirageSandboxSession:
    """The Mirage session under an SDK session, or a TypeError.

    Args:
        session (BaseSandboxSession | None): The session the SDK bound,
            usually its ``SandboxSession`` wrapper.

    Returns:
        MirageSandboxSession: The session ``MirageSandboxClient`` made.
    """
    inner = session._inner if isinstance(session, SandboxSession) else session
    if not isinstance(inner, MirageSandboxSession):
        raise TypeError(NOT_MIRAGE_SESSION)
    return inner
