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
import logging
import posixpath
import shlex
from collections.abc import Mapping

from pydantic_ai.workspaces import (
    CommandResult,
    FileEntry,
    WorkspaceCommand,
    WorkspaceRef,
    WorkspaceTimeoutError,
    WorkspaceUnavailableError,
)

from mirage.agents.pydantic_ai.constants import PROVIDER
from mirage.agents.pydantic_ai.convert import (
    io_to_command_result,
    stat_to_entry,
)
from mirage.ops.ops import Ops
from mirage.types import FileType
from mirage.workspace.tools.tool_operations import ensure_parents
from mirage.workspace.workspace import Session, Workspace

logger = logging.getLogger(__name__)


async def _remove(vfs: Ops, path: str) -> None:
    st = await vfs.stat(path, nofollow=True)
    if st.type != FileType.DIRECTORY:
        await vfs.unlink(path)
        return
    for child in await vfs.readdir(path):
        await _remove(vfs, child.rstrip("/"))
    await vfs.rmdir(path)


class MirageWorkspaceBackend:
    """A Mirage session as the environment a Pydantic AI run works in.

    Commands run in Mirage's shell and files go through its op facade,
    both as the session, so its profile judges every call. A command
    runs in a clone of the session at its working directory, as a
    subshell does: a ``cd`` or an ``export`` in one command does not
    reach the next. The ref names the session; a session that is gone
    answers ``WorkspaceUnavailableError``, and none is ever created.

    Args:
        workspace (Workspace): The workspace to operate on.
        session_id (str | None): The session to act as; None is the
            workspace's default session, named in the ref on first use.
    """

    def __init__(
        self, workspace: Workspace, session_id: str | None = None
    ) -> None:
        self._ws = workspace
        self._ref = (
            None
            if session_id is None
            else WorkspaceRef(provider=PROVIDER, id=session_id)
        )

    @property
    def ref(self) -> WorkspaceRef | None:
        return self._ref

    async def _session(self) -> Session:
        await self._ws.ensure_sessions_loaded()
        if self._ref is None:
            self._ref = WorkspaceRef(
                provider=PROVIDER, id=self._ws.default_session_id
            )
        try:
            self._ws.get_session(self._ref.id)
        except KeyError:
            raise WorkspaceUnavailableError(
                f"mirage session {self._ref.id!r} does not exist"
            ) from None
        return Session(self._ws, self._ref.id)

    async def working_dir(self) -> str:
        return (await self._session()).state.cwd

    async def run(
        self,
        command: WorkspaceCommand,
        *,
        shell: bool = False,
        env: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> CommandResult:
        if shell != isinstance(command, str):
            raise TypeError(
                "a shell string needs shell=True, an argv sequence shell=False"
            )
        line = command if isinstance(command, str) else shlex.join(command)
        session = await self._session()
        try:
            io = await asyncio.wait_for(
                session.shell(
                    line,
                    cwd=session.state.cwd,
                    env=dict(env) if env else None,
                ),
                timeout,
            )
        except TimeoutError:
            raise WorkspaceTimeoutError(
                f"command timed out after {timeout}s"
            ) from None
        return await io_to_command_result(io)

    async def read_bytes(self, path: str) -> bytes:
        return await (await self._session()).vfs.read(path)

    async def write_bytes(self, path: str, data: bytes) -> None:
        vfs = (await self._session()).vfs
        await ensure_parents(vfs, path)
        await vfs.write(path, data)

    async def stat(self, path: str) -> FileEntry:
        vfs = (await self._session()).vfs
        return stat_to_entry(path, await vfs.stat(path))

    async def list_dir(self, path: str) -> list[FileEntry]:
        vfs = (await self._session()).vfs
        entries = []
        for child in await vfs.readdir(path):
            child = child.rstrip("/")
            try:
                entries.append(stat_to_entry(child, await vfs.stat(child)))
            except OSError as exc:
                logger.debug("listing %s: %s", child, exc)
                entries.append(
                    FileEntry(
                        name=posixpath.basename(child),
                        path=child,
                        is_dir=False,
                        size=None,
                    )
                )
        return entries

    async def make_dir(self, path: str) -> None:
        vfs = (await self._session()).vfs
        await ensure_parents(vfs, path)
        try:
            await vfs.mkdir(path)
        except FileExistsError:
            if not await vfs.is_dir(path):
                raise

    async def remove(self, path: str) -> None:
        session = await self._session()
        root = session.state.cwd
        parent = await self.realpath(posixpath.dirname(path))
        target = posixpath.join(parent, posixpath.basename(path))
        if target == root or root.startswith(target.rstrip("/") + "/"):
            raise ValueError(
                "refusing to remove the working directory or an ancestor"
            )
        await _remove(session.vfs, path)

    async def exists(self, path: str) -> bool:
        return await (await self._session()).vfs.exists(path)

    async def realpath(self, path: str) -> str:
        session = await self._session()
        io = await session.shell(
            shlex.join(["realpath", "-m", "--", path]), record=False
        )
        if io.exit_code != 0:
            raise OSError((await io.stderr_str()).strip())
        return (await io.stdout_str()).removesuffix("\n")
