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
import io
import logging
import posixpath
import shlex
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Literal

from agents.sandbox.errors import ExecTimeoutError
from agents.sandbox.manifest import Manifest
from agents.sandbox.session.base_sandbox_session import BaseSandboxSession
from agents.sandbox.session.pty_types import (
    PtyExecUpdate,
    allocate_pty_process_id,
    clamp_pty_yield_time_ms,
    resolve_pty_write_yield_time_ms,
    truncate_text_by_tokens,
)
from agents.sandbox.session.sandbox_client import BaseSandboxClient
from agents.sandbox.session.sandbox_session import SandboxSession
from agents.sandbox.session.sandbox_session_state import SandboxSessionState
from agents.sandbox.snapshot import NoopSnapshot, SnapshotBase, SnapshotSpec
from agents.sandbox.types import ExecResult, User

from mirage.agents.openai_agents.constants import (
    DEFAULT_EXEC_YIELD_MS,
    DEFAULT_WRITE_YIELD_MS,
    INTERRUPT,
    INTERRUPTED_EXIT_CODE,
    NO_STDIN,
)
from mirage.workspace.snapshot import apply_state_dict, read_tar
from mirage.workspace.tools.io_text import with_refusal_bytes
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)


class MirageSandboxSessionState(SandboxSessionState):
    type: Literal["mirage"] = "mirage"


class MirageSandboxSession(BaseSandboxSession):
    """One SDK sandbox session, backed by its own Mirage shell session.

    Every command starts at the manifest root, the way each
    ``exec_command`` is a fresh ``sh -lc`` in the SDK's other
    sandboxes, so a ``cd`` or ``export`` never outlives its call. Lines
    of one session run one at a time, like one shell. The session has
    no OS users, so ``user`` arguments are accepted and ignored.

    Args:
        workspace (Workspace): The workspace every session of the
            client shares.
        state (MirageSandboxSessionState): The SDK session state.
    """

    def __init__(
        self,
        workspace: Workspace,
        state: MirageSandboxSessionState,
    ) -> None:
        self._ws = workspace
        self.state = state
        self._session_id = f"openai-{state.session_id.hex}"
        self._lines: dict[int, asyncio.Task[ExecResult]] = {}
        workspace.create_session(self._session_id)

    @property
    def workspace(self) -> Workspace:
        return self._ws

    @property
    def session_id(self) -> str:
        return self._session_id

    async def _ensure_backend_started(self) -> None:
        root_exists = await self._ws.vfs.exists(
            self.state.manifest.root, session_id=self._session_id
        )
        self._set_start_state_preserved(
            self.state.workspace_root_ready and root_exists
        )

    async def _prepare_backend_workspace(self) -> None:
        await self._mkdir_p(self.state.manifest.root)

    def _prepare_exec_command(
        self,
        *command: str | Path,
        shell: bool | list[str],
        user: str | User | None,
    ) -> list[str]:
        return [shell_line(command, bool(shell))]

    async def _exec_internal(
        self,
        *command: str | Path,
        timeout: float | None = None,
    ) -> ExecResult:
        return await self._run(shell_line(command, True), timeout)

    async def _run(
        self, line: str, timeout: float | None = None
    ) -> ExecResult:
        try:
            async with asyncio.timeout(timeout) as deadline:
                return await self._shell(line)
        except TimeoutError as exc:
            if not deadline.expired():
                raise
            raise ExecTimeoutError(command=(line,), timeout_s=timeout) from exc

    async def _shell(self, line: str) -> ExecResult:
        env = await self.state.manifest.environment.resolve()
        io_result = await self._ws.shell(
            line,
            session_id=self._session_id,
            cwd=self.state.manifest.root,
            env=env or None,
        )
        stdout = await io_result.materialize_stdout()
        stderr = with_refusal_bytes(
            await io_result.materialize_stderr(), io_result.refusal
        )
        return ExecResult(
            exit_code=io_result.exit_code, stdout=stdout, stderr=stderr
        )

    def supports_pty(self) -> bool:
        return True

    async def pty_exec_start(
        self,
        *command: str | Path,
        timeout: float | None = None,
        shell: bool | list[str] = True,
        user: str | User | None = None,
        tty: bool = False,
        yield_time_s: float | None = None,
        max_output_tokens: int | None = None,
    ) -> PtyExecUpdate:
        process_id = allocate_pty_process_id(set(self._lines))
        self._lines[process_id] = asyncio.create_task(
            self._run(shell_line(command, bool(shell)), timeout)
        )
        yield_ms = (
            DEFAULT_EXEC_YIELD_MS
            if yield_time_s is None
            else int(yield_time_s * 1000)
        )
        return await self._collect(
            process_id, clamp_pty_yield_time_ms(yield_ms), max_output_tokens
        )

    async def pty_write_stdin(
        self,
        *,
        session_id: int,
        chars: str,
        yield_time_s: float | None = None,
        max_output_tokens: int | None = None,
    ) -> PtyExecUpdate:
        task = self._resolve_pty_session_entry(
            pty_processes=self._lines, session_id=session_id
        )
        if chars.replace(INTERRUPT, ""):
            raise RuntimeError(NO_STDIN)
        if INTERRUPT in chars:
            task.cancel()
        yield_ms = (
            DEFAULT_WRITE_YIELD_MS
            if yield_time_s is None
            else int(yield_time_s * 1000)
        )
        return await self._collect(
            session_id,
            resolve_pty_write_yield_time_ms(
                yield_time_ms=yield_ms, input_empty=chars == ""
            ),
            max_output_tokens,
        )

    async def _collect(
        self, process_id: int, yield_ms: int, max_output_tokens: int | None
    ) -> PtyExecUpdate:
        task = self._lines[process_id]
        done, _ = await asyncio.wait({task}, timeout=yield_ms / 1000)
        if not done:
            return PtyExecUpdate(
                process_id=process_id,
                output=b"",
                exit_code=None,
                original_token_count=None,
            )
        del self._lines[process_id]
        if task.cancelled():
            return PtyExecUpdate(
                process_id=None,
                output=b"",
                exit_code=INTERRUPTED_EXIT_CODE,
                original_token_count=None,
            )
        result = task.result()
        text, original_token_count = truncate_text_by_tokens(
            combined_output(result), max_output_tokens
        )
        return PtyExecUpdate(
            process_id=None,
            output=text.encode("utf-8"),
            exit_code=result.exit_code,
            original_token_count=original_token_count,
        )

    async def pty_terminate_all(self) -> None:
        tasks = list(self._lines.values())
        self._lines.clear()
        for task in tasks:
            task.cancel()
        for outcome in await asyncio.gather(*tasks, return_exceptions=True):
            if isinstance(outcome, Exception):
                logger.debug(
                    "sandbox line failed while terminating: %r", outcome
                )

    def _path(self, path: Path | str) -> str:
        raw = str(path)
        if not raw.startswith("/"):
            raw = posixpath.join(self.state.manifest.root, raw)
        return posixpath.normpath(raw)

    async def _mkdir_p(self, path: str) -> None:
        io_result = await self._ws.shell(
            f"mkdir -p -- {shlex.quote(path)}",
            session_id=self._session_id,
            record=False,
        )
        if io_result.exit_code != 0:
            err = await io_result.materialize_stderr()
            raise OSError(err.decode("utf-8", errors="replace").strip())

    async def read(
        self,
        path: Path,
        *,
        user: str | User | None = None,
    ) -> io.IOBase:
        data = await self._ws.vfs.read(
            self._path(path), session_id=self._session_id
        )
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
        target = self._path(path)
        await self._mkdir_p(posixpath.dirname(target))
        await self._ws.vfs.write(target, content, session_id=self._session_id)

    async def running(self) -> bool:
        return not self._ws._closed

    async def persist_workspace(self) -> io.IOBase:
        buf = io.BytesIO()
        await self._ws.snapshot(buf)
        buf.seek(0)
        return buf

    async def hydrate_workspace(self, data: io.IOBase) -> None:
        # Restore the snapshot's non-mount state (cache, sessions,
        # inodes, history, jobs) AND each VFS's content (via
        # load_state) into THIS workspace. The workspace must already
        # have the same mount shape that was saved — Workspace.load()
        # is the alternative that constructs a fresh Workspace from
        # scratch.
        if hasattr(data, "seek"):
            data.seek(0)
        state = read_tar(data)
        await apply_state_dict(self._ws, state)

    async def close_mirage_session(self) -> None:
        """Stop the session's lines and close its Mirage session."""
        await self.pty_terminate_all()
        await self._ws.close_session(self._session_id)


def shell_line(command: Sequence[str | Path], shell: bool) -> str:
    """Spell an SDK command as one Mirage shell line.

    Args:
        command (Sequence[str | Path]): The command, one shell string
            when ``shell`` is set, else an argv.
        shell (bool): Whether a single element is already a shell line.

    Returns:
        str: The line; an argv is quoted word by word.
    """
    parts = [str(part) for part in command]
    if shell and len(parts) == 1:
        return parts[0]
    return shlex.join(parts)


def combined_output(result: ExecResult) -> str:
    """Join stdout and stderr the way the SDK's shell tool renders them.

    Args:
        result (ExecResult): The finished command.

    Returns:
        str: stdout, then stderr on a line of its own.
    """
    stdout = result.stdout.decode("utf-8", errors="replace")
    stderr = result.stderr.decode("utf-8", errors="replace")
    if stdout and stderr:
        joiner = "" if stdout.endswith("\n") else "\n"
        return f"{stdout}{joiner}{stderr}"
    return stdout or stderr


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
        mirage_session = self._sessions.pop(session.state.session_id, None)
        if mirage_session is not None:
            await mirage_session.close_mirage_session()
        return session

    async def resume(
        self,
        state: SandboxSessionState,
    ) -> SandboxSession:
        session = self._sessions.get(state.session_id)
        if session is None:
            if not isinstance(state, MirageSandboxSessionState):
                raise TypeError(
                    f"cannot resume a {state.type!r} sandbox state on mirage"
                )
            session = MirageSandboxSession(workspace=self._ws, state=state)
            self._sessions[state.session_id] = session
        return self._wrap_session(session)

    def deserialize_session_state(
        self,
        # `object`, not JsonValue: the base class in the agents SDK
        # declares it, and narrowing an override breaks Liskov.
        payload: dict[str, object],
    ) -> SandboxSessionState:
        return MirageSandboxSessionState.model_validate(payload)
