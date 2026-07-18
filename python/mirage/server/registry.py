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
import time
from typing import Any, Iterable

from mirage import Workspace, WorkspaceRunner
from mirage.utils.ids import new_workspace_id

logger = logging.getLogger(__name__)


class WorkspaceEntry:

    def __init__(self, workspace_id: str, runner: WorkspaceRunner) -> None:
        self.id = workspace_id
        self.runner = runner
        self.created_at = time.time()


class WorkspaceRegistry:
    """In-memory map of workspace_id -> WorkspaceRunner.

    Owns the lifecycle for each workspace inside the daemon process:
    register on create, drop on delete, and trip an idle-shutdown
    event when the registry empties for ``idle_grace_seconds``.

    Threading: the underlying ``dict`` is mutated only from the FastAPI
    server loop (the same loop the registry is constructed on), so no
    external lock is required.
    """

    def __init__(self,
                 idle_grace_seconds: float = 30.0,
                 exit_event: asyncio.Event | None = None) -> None:
        """Construct an empty registry.

        Args:
            idle_grace_seconds (float): seconds to wait after the last
                workspace is removed before signalling exit. ``0``
                means exit immediately on empty.
            exit_event (asyncio.Event | None): event to set when the
                idle timer fires. Defaults to a fresh event.
        """
        self._entries: dict[str, WorkspaceEntry] = {}
        self.idle_grace_seconds = idle_grace_seconds
        self.exit_event = (exit_event
                           if exit_event is not None else asyncio.Event())
        self._idle_task: asyncio.Task[Any] | None = None

    def __contains__(self, workspace_id: str) -> bool:
        return workspace_id in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, workspace_id: str) -> WorkspaceEntry:
        if workspace_id not in self._entries:
            raise KeyError(workspace_id)
        return self._entries[workspace_id]

    def list(self) -> list[WorkspaceEntry]:
        return list(self._entries.values())

    def items(self) -> Iterable[tuple[str, WorkspaceEntry]]:
        return self._entries.items()

    def add(self,
            workspace: Workspace,
            workspace_id: str | None = None) -> WorkspaceEntry:
        """Wrap ``workspace`` in a runner and register it.

        Args:
            workspace (Workspace): freshly-constructed workspace.
            workspace_id (str | None): explicit id, or None to auto-mint.

        Returns:
            WorkspaceEntry: the registered entry.

        Raises:
            ValueError: ``workspace_id`` is already registered.
        """
        wid = workspace_id or new_workspace_id()
        if wid in self._entries:
            raise ValueError(f"workspace id already exists: {wid!r}")
        runner = WorkspaceRunner(workspace)
        entry = WorkspaceEntry(wid, runner)
        self._entries[wid] = entry
        self._cancel_idle_timer()
        return entry

    async def remove(self, workspace_id: str) -> WorkspaceEntry:
        """Stop the runner for ``workspace_id`` and drop it.

        Args:
            workspace_id (str): id to remove.

        Returns:
            WorkspaceEntry: the removed entry (after its runner is
                stopped).

        Raises:
            KeyError: ``workspace_id`` is not registered.
        """
        if workspace_id not in self._entries:
            raise KeyError(workspace_id)
        entry = self._entries.pop(workspace_id)
        await entry.runner.stop()
        if not self._entries:
            self._start_idle_timer()
        return entry

    async def close_all(self) -> None:
        """Stop every runner. Used at daemon shutdown."""
        self._cancel_idle_timer()
        ids = list(self._entries)
        for wid in ids:
            entry = self._entries.pop(wid)
            try:
                await entry.runner.stop()
            except Exception:
                logger.exception("error stopping runner for %s", wid)

    def _start_idle_timer(self) -> None:
        if self.idle_grace_seconds <= 0:
            self.exit_event.set()
            return
        if self._idle_task is not None and not self._idle_task.done():
            return
        self._idle_task = asyncio.create_task(self._idle_wait())

    def _cancel_idle_timer(self) -> None:
        if self._idle_task is not None and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = None

    async def _idle_wait(self) -> None:
        try:
            await asyncio.sleep(self.idle_grace_seconds)
        except asyncio.CancelledError:
            return
        if not self._entries:
            self.exit_event.set()
