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
import os
import threading
from collections.abc import Callable
from functools import partial
from typing import TextIO

from tools.environments.base import BaseEnvironment

from mirage.agents.hermes.constants import SESSION_PREFIX
from mirage.utils.abort import MirageAbortError
from mirage.workspace.session.session import SessionState
from mirage.workspace.tools.io_text import decision_line
from mirage.workspace.workspace import Workspace

logger = logging.getLogger(__name__)


class LineProcess:
    """The process handle hermes waits on for one Mirage line.

    hermes polls ``poll()``, drains ``stdout`` and calls ``kill()`` on a
    timeout or interrupt. The line runs on a worker thread and writes
    its output to the pipe as it prints, so what a cancelled line
    printed still reaches hermes.

    Args:
        run (Callable[[LineProcess], int]): Runs the line, writing its
            output through ``write``, and returns its exit status.
        cancel (Callable[[], None]): Cancels the running line.
    """

    def __init__(
        self, run: Callable[["LineProcess"], int], cancel: Callable[[], None]
    ) -> None:
        read_fd, self._write_fd = os.pipe()
        self.stdout: TextIO = os.fdopen(
            read_fd, "r", encoding="utf-8-sig", errors="replace"
        )
        self.returncode: int | None = None
        self.ended_with_newline = True
        self._cancel = cancel
        self._done = threading.Event()
        threading.Thread(target=self._work, args=(run,), daemon=True).start()

    def _work(self, run: Callable[["LineProcess"], int]) -> None:
        try:
            self.returncode = run(self)
        finally:
            os.close(self._write_fd)
            self._done.set()

    def write(self, data: bytes) -> None:
        """Hand output to hermes; dropped once hermes stops reading."""
        if data:
            self.ended_with_newline = data.endswith(b"\n")
        view = memoryview(data)
        try:
            while view:
                view = view[os.write(self._write_fd, view) :]
        except OSError as exc:
            logger.debug("hermes stopped reading a mirage line: %r", exc)

    def poll(self) -> int | None:
        return self.returncode if self._done.is_set() else None

    def wait(self, timeout: float | None = None) -> int | None:
        self._done.wait(timeout)
        return self.returncode

    def kill(self) -> None:
        self._cancel()


class MirageEnvironment(BaseEnvironment):
    """A hermes terminal environment backed by Mirage sessions.

    hermes' ``execute()`` wraps each command and hands it to
    ``_run_bash``, which runs it as one line of an idle session of this
    task. hermes polls background jobs while a foreground command runs,
    and a session runs one line at a time, so a busy task opens another
    session. Every session stays open until ``cleanup()``, so a job
    lives as long as the task, and ``processes: workspace`` lets a poll
    in one session see a job started in another.

    Args:
        workspace (Workspace): The workspace the sessions live in.
        cwd (str): Directory the first command starts in.
        timeout (int): Default command timeout in seconds.
        task_id (str): hermes task the sessions belong to.

    Raises:
        ValueError: the workspace does not grant ``processes: workspace``.
    """

    _stdin_mode = "payload"

    def __init__(
        self, workspace: Workspace, *, cwd: str, timeout: int, task_id: str
    ) -> None:
        super().__init__(cwd=cwd, timeout=timeout)
        self._ws = workspace
        self._ws._sync_bridge.attach()
        self._prefix = f"{SESSION_PREFIX}{task_id}-{self._session_id}-"
        self._lock = threading.Lock()
        self._sessions: list[str] = []
        self._idle: list[str] = []
        self._closed = False
        processes = self._open_session().processes
        if processes.kill != "workspace":
            self.cleanup()
            raise ValueError(
                "the mirage backend needs `processes: workspace` in the "
                "workspace YAML, so hermes can poll a background job from "
                "another session"
            )
        self.init_session()

    async def _create_session(self, session_id: str) -> SessionState:
        return self._ws.create_session(session_id)

    def _open_session(self) -> SessionState:
        session_id = f"{self._prefix}{len(self._sessions)}"
        state = self._ws._run_sync(
            partial(self._create_session, session_id), "create_session"
        )
        self._sessions.append(session_id)
        self._idle.append(session_id)
        return state

    def _acquire(self) -> str:
        with self._lock:
            if self._closed:
                raise RuntimeError("the mirage environment is closed")
            if not self._idle:
                self._open_session()
            return self._idle.pop()

    def _release(self, session_id: str) -> None:
        with self._lock:
            self._idle.append(session_id)

    def _cancel(self, event: asyncio.Event) -> None:
        loop = self._ws._sync_bridge.loop
        if loop is not None:
            loop.call_soon_threadsafe(event.set)

    def _run_bash(
        self,
        cmd_string: str,
        *,
        login: bool = False,
        timeout: int = 120,
        stdin_data: str | None = None,
    ) -> LineProcess:
        stdin = stdin_data.encode() if stdin_data else None
        cancel = asyncio.Event()

        async def run(session_id: str, process: LineProcess) -> int:
            execution = await self._ws.shell(
                cmd_string,
                session_id=session_id,
                stdin=stdin,
                cancel=cancel,
                stream=True,
            )
            async with execution:
                async for event in execution.events:
                    await asyncio.to_thread(process.write, event.data)
                result = await execution.wait()
            note = decision_line(result.decision)
            if note:
                lead = "" if process.ended_with_newline else "\n"
                await asyncio.to_thread(
                    process.write, f"{lead}{note}".encode()
                )
            return result.exit_code

        def execute(process: LineProcess) -> int:
            try:
                session_id = self._acquire()
                try:
                    return self._ws._run_sync(
                        partial(run, session_id, process), "shell"
                    )
                finally:
                    self._release(session_id)
            except MirageAbortError:
                return 130
            except Exception as exc:
                logger.debug("mirage line failed: %r", exc)
                process.write(f"mirage: {exc}\n".encode())
                return 1

        return LineProcess(execute, partial(self._cancel, cancel))

    def cleanup(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            sessions = list(self._sessions)
            self._idle.clear()
        for session_id in sessions:
            try:
                self._ws._run_sync(
                    partial(self._ws.close_session, session_id),
                    "close_session",
                )
            except Exception as exc:
                logger.debug("closing %s failed: %r", session_id, exc)
