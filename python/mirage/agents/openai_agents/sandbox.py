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

import io
import uuid
from pathlib import Path
from typing import Literal

from agents.sandbox.manifest import Manifest
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.sandbox_client import BaseSandboxClient
from agents.sandbox.session.sandbox_session import SandboxSession
from agents.sandbox.session.sandbox_session_state import SandboxSessionState
from agents.sandbox.snapshot import NoopSnapshot, SnapshotBase, SnapshotSpec
from agents.sandbox.types import ExecResult, User

from mirage.workspace.snapshot import apply_state_dict, read_tar
from mirage.workspace.workspace import Workspace


class MirageSandboxSessionState(SandboxSessionState):
    type: Literal["mirage"] = "mirage"


class MirageSandboxSession(BaseSandboxSession):

    def __init__(
        self,
        workspace: Workspace,
        state: MirageSandboxSessionState,
    ) -> None:
        self._ws = workspace
        self.state = state

    async def _exec_internal(
        self,
        *command: str | Path,
        timeout: float | None = None,
    ) -> ExecResult:
        cmd_str = " ".join(str(c) for c in command)
        io_result = await self._ws.execute(cmd_str)
        stdout = (io_result.stdout or b"")
        stderr = (io_result.stderr or b"")
        if isinstance(stdout, str):
            stdout = stdout.encode("utf-8")
        if isinstance(stderr, str):
            stderr = stderr.encode("utf-8")
        return ExecResult(
            exit_code=io_result.exit_code,
            stdout=stdout,
            stderr=stderr,
        )

    async def read(
        self,
        path: Path,
        *,
        user: str | User | None = None,
    ) -> io.IOBase:
        data = await self._ws.ops.read(str(path))
        return io.BytesIO(data)

    async def write(
        self,
        path: Path,
        data: io.IOBase,
        *,
        user: str | User | None = None,
    ) -> None:
        content = data.read()
        if isinstance(content, str):
            content = content.encode("utf-8")
        parent = str(path.parent)
        if parent and parent != ".":
            try:
                await self._ws.ops.mkdir(parent)
            except (FileExistsError, ValueError):
                # mkdir -p semantics: an existing parent is success
                pass
        await self._ws.ops.write(str(path), content)

    def _prepare_exec_command(
        self,
        *command: str | Path,
        shell: bool | list[str],
        user: str | User | None,
    ) -> list[str]:
        return [str(c) for c in command]

    async def running(self) -> bool:
        return not self._ws._closed

    async def persist_workspace(self) -> io.IOBase:
        buf = io.BytesIO()
        await self._ws.snapshot(buf)
        buf.seek(0)
        return buf

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        # Restore the snapshot's non-mount state (cache, sessions,
        # inodes, history, jobs) AND each resource's content (via
        # load_state) into THIS workspace. The workspace must already
        # have the same mount shape that was saved — Workspace.load()
        # is the alternative that constructs a fresh Workspace from
        # scratch.
        if hasattr(data, "seek"):
            data.seek(0)
        state = read_tar(data)
        await apply_state_dict(self._ws, state)


class MirageSandboxClient(BaseSandboxClient[None]):
    # In-process integration: every sandbox session shares one Workspace
    # instance owned by the agent's process. No HTTP, no daemon -- the
    # agent and the workspace run on the same event loop.
    #
    # If you need cross-process isolation (each agent talks to a
    # workspace hosted in a separate daemon process), see
    # docs/plans/2026-04-17-workspace-server-cli.md -- a
    # MirageRemoteSandboxClient that speaks HTTP to `mirage daemon`
    # would slot into the same BaseSandboxClient interface.

    backend_id: str = "mirage"
    supports_default_options: bool = True

    def __init__(self, workspace: Workspace) -> None:
        self._ws = workspace
        self._sessions: dict[uuid.UUID, MirageSandboxSession] = {}

    async def create(
        self,
        *,
        snapshot: SnapshotSpec | SnapshotBase | None = None,
        manifest: Manifest | None = None,
        options: None = None,
    ) -> SandboxSession:
        session_id = uuid.uuid4()
        snapshot_id = str(session_id)

        snap: SnapshotBase
        if isinstance(snapshot, SnapshotSpec):
            snap = snapshot.build(snapshot_id)
        elif isinstance(snapshot, SnapshotBase):
            snap = snapshot
        else:
            snap = NoopSnapshot(id=snapshot_id)

        state = MirageSandboxSessionState(
            session_id=session_id,
            snapshot=snap,
            manifest=manifest or Manifest(root="/"),
        )
        session = MirageSandboxSession(workspace=self._ws, state=state)
        self._sessions[session_id] = session
        return self._wrap_session(session)

    async def delete(self, session: SandboxSession) -> SandboxSession:
        sid = session.state.session_id
        self._sessions.pop(sid, None)
        return session

    async def resume(
        self,
        state: SandboxSessionState,
    ) -> SandboxSession:
        sid = state.session_id
        session = self._sessions.get(sid)
        if session is None:
            raise ValueError(f"No session to resume: {sid}")
        return self._wrap_session(session)

    def deserialize_session_state(
        self,
        payload: dict[str, object],
    ) -> SandboxSessionState:
        return MirageSandboxSessionState.model_validate(payload)
