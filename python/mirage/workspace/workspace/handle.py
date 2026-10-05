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

import asyncio
from typing import TYPE_CHECKING

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.ops.ops import Ops
from mirage.workspace.session import SessionState

if TYPE_CHECKING:
    from mirage.workspace.tools.file_version import FileVersionTracker
    from mirage.workspace.tools.tool_operations import MirageToolOperations
    from mirage.workspace.workspace.workspace import Workspace


class Session:
    """One session's doors, bound together.

    ``shell`` runs a line as the session, ``vfs`` is the op facade run
    as it and ``tools`` the agent tools over both, so a host holds one
    object per agent and every door answers under the same profile:
    hides, mount modes, grants and standing decisions. Nothing is
    stored here; the session record stays with the session manager and
    ``state`` reads it. Obtained from ``Workspace.session``, which
    creates the session or adopts it. A None id is the workspace's
    default session as it is when each call runs, the way ``ws.vfs``
    and ``ws.shell`` follow it when a snapshot load or an attach
    re-keys it.
    """

    def __init__(self, ws: "Workspace", session_id: str | None) -> None:
        self._ws = ws
        self._id = session_id

    @property
    def session_id(self) -> str:
        return (
            self._id if self._id is not None else self._ws.default_session_id
        )

    @property
    def state(self) -> SessionState:
        """The session record: cwd, env, modes, hides, decisions."""
        return self._ws.get_session(self.session_id)

    @property
    def vfs(self) -> Ops:
        """The op facade run as this session."""
        if self._id is None:
            return self._ws.vfs
        return self._ws.vfs._for_session(self._id)

    @property
    def tools(self) -> "MirageToolOperations":
        """The agent tools run as this session: one table per session,
        shared by every caller in the process."""
        return self._ws._session_tools(self._id)

    async def _reads(self) -> "FileVersionTracker":
        """The read history the session's agent tools share."""
        return await self._ws._session_reads(self._id)

    async def shell(
        self,
        command: str,
        stdin: ByteSource | None = None,
        agent_id: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        cancel: asyncio.Event | None = None,
        record: bool = True,
        runtime: str | None = None,
    ) -> IOResult:
        """Run a shell line as this session; ``Workspace.shell`` with
        the session fixed.

        Args:
            command (str): the shell line.
            stdin (ByteSource | None): stdin payload.
            agent_id (str | None): agent identifier for observability.
            cwd (str | None): per-call working directory, run in an
                ephemeral clone of the session.
            env (dict[str, str] | None): per-call env overrides, run in
                an ephemeral clone of the session.
            cancel (asyncio.Event | None): abort signal.
            record (bool): whether the line enters history.
            runtime (str | None): the runtime to route the line to.
        """
        return await self._ws.shell(
            command,
            session_id=self._id,
            stdin=stdin,
            agent_id=agent_id,
            cwd=cwd,
            env=env,
            cancel=cancel,
            record=record,
            runtime=runtime,
        )

    async def glob(self, pattern: str) -> list[str]:
        """The paths a pattern matches as this session;
        ``Workspace.glob`` with the session fixed.

        Args:
            pattern (str): the pattern, such as ``/src/**/*.py``.
        """
        return await self._ws.glob(pattern, session_id=self._id)
