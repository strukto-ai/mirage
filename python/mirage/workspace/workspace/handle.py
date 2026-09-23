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
from typing import TYPE_CHECKING, Literal, overload

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.ops.ops import Ops
from mirage.provision import ProvisionResult
from mirage.workspace.session import SessionState

if TYPE_CHECKING:
    from mirage.workspace.workspace.workspace import Workspace


class Session:
    """One session's two doors, bound together.

    ``shell`` runs a line as the session and ``vfs`` is the op facade
    run as it, so a host holds one object per agent and both doors
    answer under the same profile: hides, mount modes, grants and
    standing decisions. Nothing is stored here; the session record
    stays with the session manager and ``state`` reads it. Obtained
    from ``Workspace.session``, which creates the session or adopts it.
    """

    def __init__(self, ws: "Workspace", session_id: str) -> None:
        self._ws = ws
        self._id = session_id

    @property
    def session_id(self) -> str:
        return self._id

    @property
    def state(self) -> SessionState:
        """The session record: cwd, env, modes, hides, decisions."""
        return self._ws.get_session(self._id)

    @property
    def vfs(self) -> Ops:
        """The op facade run as this session."""
        return self._ws.vfs._for_session(self._id)

    @overload
    async def shell(self,
                    command: str,
                    stdin: ByteSource | None = ...,
                    provision: Literal[False] = ...,
                    agent_id: str | None = ...,
                    cwd: str | None = ...,
                    env: dict[str, str] | None = ...,
                    cancel: asyncio.Event | None = ...,
                    record: bool = ...,
                    runtime: str | None = ...) -> IOResult:
        ...

    @overload
    async def shell(self,
                    command: str,
                    stdin: ByteSource | None = ...,
                    *,
                    provision: Literal[True],
                    agent_id: str | None = ...,
                    cwd: str | None = ...,
                    env: dict[str, str] | None = ...,
                    cancel: asyncio.Event | None = ...,
                    record: bool = ...,
                    runtime: str | None = ...) -> ProvisionResult:
        ...

    async def shell(self,
                    command: str,
                    stdin: ByteSource | None = None,
                    provision: bool = False,
                    agent_id: str | None = None,
                    cwd: str | None = None,
                    env: dict[str, str] | None = None,
                    cancel: asyncio.Event | None = None,
                    record: bool = True,
                    runtime: str | None = None) -> IOResult | ProvisionResult:
        """Run a shell line as this session; ``Workspace.shell`` with
        the session fixed.

        Args:
            command (str): the shell line.
            stdin (ByteSource | None): stdin payload.
            provision (bool): return a ProvisionResult instead of running.
            agent_id (str | None): agent identifier for observability.
            cwd (str | None): per-call working directory, run in an
                ephemeral clone of the session.
            env (dict[str, str] | None): per-call env overrides, run in
                an ephemeral clone of the session.
            cancel (asyncio.Event | None): abort signal.
            record (bool): whether the line enters history.
            runtime (str | None): the runtime to route the line to.
        """
        if provision:
            return await self._ws.shell(command,
                                        session_id=self._id,
                                        stdin=stdin,
                                        provision=True,
                                        agent_id=agent_id,
                                        cwd=cwd,
                                        env=env,
                                        cancel=cancel,
                                        record=record,
                                        runtime=runtime)
        return await self._ws.shell(command,
                                    session_id=self._id,
                                    stdin=stdin,
                                    agent_id=agent_id,
                                    cwd=cwd,
                                    env=env,
                                    cancel=cancel,
                                    record=record,
                                    runtime=runtime)
