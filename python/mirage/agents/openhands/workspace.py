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
import shlex
import threading
from pathlib import Path
from typing import Any

from openhands.sdk.git.models import GitChange, GitDiff
from openhands.sdk.workspace.local import LocalWorkspace
from openhands.sdk.workspace.models import CommandResult, FileOperationResult
from pydantic import Field, PrivateAttr

from mirage.workspace.workspace import Workspace as MirageBackingWorkspace

logger = logging.getLogger(__name__)


def _run_loop_in_thread(state: dict[str, Any], ready: threading.Event) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    state["loop"] = loop
    ready.set()
    try:
        loop.run_forever()
    finally:
        loop.close()


async def _execute_with_timeout(
    ws: MirageBackingWorkspace,
    command: str,
    timeout: float,
) -> Any:
    return await asyncio.wait_for(ws.execute(command), timeout=timeout)


class _AsyncBridge:

    def __init__(self) -> None:
        self._state: dict[str, Any] = {}
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def _ensure(self) -> asyncio.AbstractEventLoop:
        with self._lock:
            loop = self._state.get("loop")
            if loop is not None:
                return loop
            ready = threading.Event()
            t = threading.Thread(
                target=_run_loop_in_thread,
                args=(self._state, ready),
                name="mirage-openhands-loop",
                daemon=True,
            )
            t.start()
            ready.wait()
            self._thread = t
            return self._state["loop"]

    def run(self, coro: Any, timeout: float | None = None) -> Any:
        loop = self._ensure()
        fut = asyncio.run_coroutine_threadsafe(coro, loop)
        return fut.result(timeout=timeout)

    def shutdown(self) -> None:
        with self._lock:
            loop = self._state.get("loop")
            if loop is None:
                return
            self._state.pop("loop", None)
            loop.call_soon_threadsafe(loop.stop)
            if self._thread is not None:
                self._thread.join(timeout=5)
                self._thread = None


class MirageWorkspace(LocalWorkspace):
    """OpenHands LocalWorkspace adapter backed by a Mirage Workspace.

    Inherits LocalWorkspace so OpenHands' Conversation isinstance check
    passes, but overrides every operation to route through a Mirage
    Workspace's virtual filesystem and shell. The async-to-sync bridge
    dispatches coroutines onto a dedicated background event loop.

    Args:
        workspace: Mirage Workspace instance to delegate filesystem and
            shell operations to.
        working_dir: Default working directory used as cwd for shell
            commands when no explicit cwd is provided. Must be a valid
            host path (OpenHands validates it on the host fs). Defaults
            to "/".
    """

    working_dir: str = Field(
        default="/",
        description="Default working directory inside the Mirage workspace.",
    )

    _ws: Any = PrivateAttr()
    _bridge: Any = PrivateAttr()

    def __init__(
        self,
        *,
        workspace: MirageBackingWorkspace,
        working_dir: str = "/",
        **kwargs: Any,
    ) -> None:
        super().__init__(working_dir=working_dir, **kwargs)
        self._ws = workspace
        self._bridge = _AsyncBridge()

    @property
    def workspace(self) -> MirageBackingWorkspace:
        return self._ws

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        try:
            if not self._ws._closed:
                self._bridge.run(self._ws.close())
        finally:
            self._bridge.shutdown()

    def execute_command(
        self,
        command: str,
        cwd: str | Path | None = None,
        timeout: float = 30.0,
    ) -> CommandResult:
        cwd_str = str(cwd) if cwd is not None else self.working_dir
        if cwd_str and cwd_str not in ("", "."):
            full_command = f"cd {shlex.quote(cwd_str)} && {command}"
        else:
            full_command = command
        try:
            io_result = self._bridge.run(
                _execute_with_timeout(self._ws, full_command, timeout))
            stdout = self._coerce_text(getattr(io_result, "stdout", b""))
            stderr = self._coerce_text(getattr(io_result, "stderr", b""))
            exit_code = int(getattr(io_result, "exit_code", 0) or 0)
            return CommandResult(
                command=command,
                exit_code=exit_code,
                stdout=stdout,
                stderr=stderr,
                timeout_occurred=False,
            )
        except asyncio.TimeoutError:
            return CommandResult(
                command=command,
                exit_code=-1,
                stdout="",
                stderr=f"Command timed out after {timeout}s",
                timeout_occurred=True,
            )

    def file_upload(
        self,
        source_path: str | Path,
        destination_path: str | Path,
    ) -> FileOperationResult:
        src = Path(source_path)
        dst = str(destination_path)
        try:
            data = src.read_bytes()
            parent = str(Path(dst).parent)
            if parent and parent not in (".", "/"):
                self._ensure_parent(parent)
            self._bridge.run(self._ws.ops.write(dst, data))
            return FileOperationResult(
                success=True,
                source_path=str(src),
                destination_path=dst,
                file_size=len(data),
            )
        except Exception as e:
            logger.error("file_upload %s -> %s failed: %s", src, dst, e)
            return FileOperationResult(
                success=False,
                source_path=str(src),
                destination_path=dst,
                error=str(e),
            )

    def file_download(
        self,
        source_path: str | Path,
        destination_path: str | Path,
    ) -> FileOperationResult:
        src = str(source_path)
        dst = Path(destination_path)
        try:
            data = self._bridge.run(self._ws.ops.read(src))
            if isinstance(data, str):
                data = data.encode("utf-8")
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            return FileOperationResult(
                success=True,
                source_path=src,
                destination_path=str(dst),
                file_size=len(data),
            )
        except Exception as e:
            logger.error("file_download %s -> %s failed: %s", src, dst, e)
            return FileOperationResult(
                success=False,
                source_path=src,
                destination_path=str(dst),
                error=str(e),
            )

    def git_changes(self, path: str | Path) -> list[GitChange]:
        raise NotImplementedError(
            "Mirage workspaces do not expose git semantics over their "
            "virtual mounts; query the underlying resource directly.")

    def git_diff(self, path: str | Path) -> GitDiff:
        raise NotImplementedError(
            "Mirage workspaces do not expose git semantics over their "
            "virtual mounts; query the underlying resource directly.")

    def _ensure_parent(self, parent: str) -> None:
        result = self._bridge.run(
            self._ws.execute(f"mkdir -p {shlex.quote(parent)}"))
        exit_code = int(getattr(result, "exit_code", 0) or 0)
        if exit_code != 0:
            stderr = self._coerce_text(getattr(result, "stderr", b""))
            raise RuntimeError(
                f"mkdir -p {parent!r} failed (exit {exit_code}): {stderr}")

    @staticmethod
    def _coerce_text(value: Any) -> str:
        if isinstance(value, (bytes, bytearray)):
            return value.decode("utf-8", errors="replace")
        if value is None:
            return ""
        return str(value)
