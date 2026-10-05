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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from enum import StrEnum
from typing import Any, Iterable

from mirage import Workspace, WorkspaceRunner
from mirage.utils.ids import new_workspace_id
from mirage.workspace.record.disk import DiskRecordClient

logger = logging.getLogger(__name__)

# Under the daemon's state root: one record per workspace id naming the
# account that owns it.
OWNERS_PREFIX = "owners"


class Claim(StrEnum):
    """What a create's claim on an id found."""

    NEW = "new"
    HELD = "held"
    TAKEN = "taken"


class WorkspaceEntry:
    """One registered workspace.

    Args:
        workspace_id (str): the registry id.
        runner (WorkspaceRunner): the runner driving it.
        owner (str | None): the account that created it; None when it
            was created by a caller with no account.
    """

    def __init__(
        self,
        workspace_id: str,
        runner: WorkspaceRunner,
        owner: str | None = None,
    ) -> None:
        self.id = workspace_id
        self.runner = runner
        self.owner = owner
        self.created_at = time.time()
        self.config_digest: str | None = None


class WorkspaceRegistry:
    """In-memory map of workspace_id -> WorkspaceRunner.

    Owns the lifecycle for each workspace inside the daemon process:
    register on create, drop on delete, and trip an idle-shutdown
    event when the registry empties for ``idle_grace_seconds``.

    Threading: the underlying ``dict`` is mutated only from the FastAPI
    server loop (the same loop the registry is constructed on), so no
    external lock is required.
    """

    def __init__(
        self,
        idle_grace_seconds: float = 30.0,
        exit_event: asyncio.Event | None = None,
        accounts_required: bool = False,
        owners: DiskRecordClient | None = None,
    ) -> None:
        """Construct an empty registry.

        Args:
            idle_grace_seconds (float): seconds to wait after the last
                workspace is removed before signalling exit. ``0``
                means exit immediately on empty.
            exit_event (asyncio.Event | None): event to set when the
                idle timer fires. Defaults to a fresh event.
            accounts_required (bool): refuse callers with no account
                (jwt mode); otherwise such a caller may use every
                workspace.
            owners (DiskRecordClient | None): where each workspace id's
                owning account is kept across restarts, so a stored
                workspace is only ever reopened by its owner. None keeps
                ownership in memory.
        """
        self._entries: dict[str, WorkspaceEntry] = {}
        self.accounts_required = accounts_required
        self._owners = owners
        self._removals: dict[str, asyncio.Task[WorkspaceEntry]] = {}
        self._creates: dict[str, tuple[str, asyncio.Future[None]]] = {}
        self.idle_grace_seconds = idle_grace_seconds
        self.exit_event = (
            exit_event if exit_event is not None else asyncio.Event()
        )
        self._idle_task: asyncio.Task[Any] | None = None

    def __contains__(self, workspace_id: str) -> bool:
        return workspace_id in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    @asynccontextmanager
    async def creating(
        self, workspace_id: str, config_digest: str
    ) -> AsyncIterator[bool]:
        """Run one create of ``workspace_id`` at a time.

        A create of the same config that arrives while another is
        building waits for it, then finds the workspace it registered,
        rather than building a second over its state; it would stall on
        the same secrets and mounts anyway. A create of another config is
        not admitted and does not wait, so a stuck create never holds it.

        Args:
            workspace_id (str): the id being created.
            config_digest (str): the fingerprint of the config it is
                created from.

        Yields:
            bool: True when this create holds the id; False when another
                config's create is building it.
        """
        while (pending := self._creates.get(workspace_id)) is not None:
            digest, building = pending
            if digest != config_digest:
                yield False
                return
            await asyncio.wait({building})
        done = asyncio.get_running_loop().create_future()
        self._creates[workspace_id] = (config_digest, done)
        try:
            yield True
        finally:
            del self._creates[workspace_id]
            done.set_result(None)

    def removing(self, workspace_id: str) -> bool:
        """Whether ``workspace_id`` is being deleted or closed.

        Args:
            workspace_id (str): id to check.

        Returns:
            bool: True while a ``remove`` or ``close`` of it is in flight.
        """
        return workspace_id in self._removals

    def get(self, workspace_id: str) -> WorkspaceEntry:
        if workspace_id not in self._entries:
            raise KeyError(workspace_id)
        return self._entries[workspace_id]

    def list(self) -> list[WorkspaceEntry]:
        return list(self._entries.values())

    def items(self) -> Iterable[tuple[str, WorkspaceEntry]]:
        return self._entries.items()

    def visible(
        self, workspace_id: str, account: str | None
    ) -> WorkspaceEntry | None:
        """The live entry ``account`` may use, else None.

        The one access rule every door asks. A caller with no account
        may use every workspace unless accounts are required; an
        account may use only the workspaces it owns, so one created by
        a caller with no account is closed to every account. A
        workspace that exists but belongs to another account answers
        None like a missing one, so its id does not leak.

        Args:
            workspace_id (str): the workspace asked for.
            account (str | None): the caller's account.
        """
        entry = self._entries.get(workspace_id)
        if entry is None:
            return None
        if account is None:
            return None if self.accounts_required else entry
        return entry if entry.owner == account else None

    async def allows(
        self, workspace_id: str, account: str | None, at: float
    ) -> bool:
        """Whether ``account`` may reach a record ``workspace_id`` made.

        The same rule as ``visible``, for an id that may not be live:
        a closed workspace's jobs, or a stored workspace after a
        restart, answer to the owner its claim names. A live workspace
        answers only for records made since it was created, so a
        workspace created again under a deleted one's id never reaches
        what the deleted one left.

        Args:
            workspace_id (str): the workspace the record belongs to.
            account (str | None): the caller's account.
            at (float): when the record was made.
        """
        if account is None:
            return not self.accounts_required
        if workspace_id in self._entries:
            entry = self.visible(workspace_id, account)
            return entry is not None and at >= entry.created_at
        if self._owners is None:
            return False
        stored, _ = await self._owners.get(workspace_id)
        return stored is not None and stored.get("account") == account

    async def claim(
        self, workspace_id: str, account: str | None, stored: bool
    ) -> Claim:
        """Record ``account`` as the owner of ``workspace_id``.

        The claim outlives the daemon, so after a restart the stored
        workspace under that id reopens only for the same account. A
        caller with no account claims nothing. An id with stored state
        and no owner (written before accounts were required) is no
        account's to take.

        Args:
            workspace_id (str): the id being created.
            account (str | None): the creating caller's account.
            stored (bool): whether the id already has stored state.

        Returns:
            Claim: NEW when this call recorded the owner, HELD when the
                account already owned the id (or none is recorded), TAKEN
                when it is not the account's to create.
        """
        if account is None or self._owners is None:
            return Claim.HELD
        record, _ = await self._owners.get(workspace_id)
        if record is None and not stored:
            claimed = {"account": account, "generation": 1}
            if await self._owners.cas_put(workspace_id, claimed, 0):
                return Claim.NEW
            record, _ = await self._owners.get(workspace_id)
        if record is not None and record.get("account") == account:
            return Claim.HELD
        return Claim.TAKEN

    async def release(self, workspace_id: str) -> None:
        """Drop the owner a failed create recorded, freeing the id.

        Args:
            workspace_id (str): the id whose claim is released.
        """
        if self._owners is not None:
            await self._owners.delete([workspace_id])

    def add(
        self,
        workspace: Workspace,
        workspace_id: str | None = None,
        owner: str | None = None,
    ) -> WorkspaceEntry:
        """Wrap ``workspace`` in a runner and register it.

        Args:
            workspace (Workspace): freshly-constructed workspace.
            workspace_id (str | None): explicit id, or None to auto-mint.
            owner (str | None): the creating caller's account.

        Returns:
            WorkspaceEntry: the registered entry.

        Raises:
            ValueError: ``workspace_id`` is already registered, or still
                being deleted or closed.
        """
        wid = workspace_id or new_workspace_id()
        if wid in self._entries or wid in self._removals:
            raise ValueError(f"workspace id already exists: {wid!r}")
        runner = WorkspaceRunner(workspace)
        entry = WorkspaceEntry(wid, runner, owner)
        self._entries[wid] = entry
        self._cancel_idle_timer()
        return entry

    async def remove(self, workspace_id: str) -> WorkspaceEntry:
        """Delete ``workspace_id``: stop its runner and drop its state.

        The workspace's links, history, sessions, metadata and owner
        leave with it, so a workspace created later under the same id
        starts empty, for any account. ``close_all`` (daemon shutdown)
        keeps them. The id stays registered until the deletion is done, so
        a create under it is refused rather than registering a workspace
        whose state this deletion would then remove. An overlapping remove
        of the same id joins the deletion in flight, so it never
        unregisters a workspace created after it.

        Args:
            workspace_id (str): id to remove.

        Returns:
            WorkspaceEntry: the removed entry (after its runner is
                stopped).

        Raises:
            KeyError: ``workspace_id`` is not registered.
        """
        removal = self._removals.get(workspace_id)
        if removal is None:
            if workspace_id not in self._entries:
                raise KeyError(workspace_id)
            removal = asyncio.create_task(
                self._remove(self._entries[workspace_id])
            )
            self._removals[workspace_id] = removal
        return await asyncio.shield(removal)

    async def _remove(self, entry: WorkspaceEntry) -> WorkspaceEntry:
        """Run one deletion, releasing the id once it is done.

        Args:
            entry (WorkspaceEntry): the entry being deleted.
        """
        try:
            await entry.runner.stop(delete=True)
            if self._owners is not None:
                await self._owners.delete([entry.id])
        finally:
            del self._removals[entry.id]
            self._entries.pop(entry.id, None)
            if not self._entries:
                self._start_idle_timer()
        return entry

    async def close(self, workspace_id: str) -> WorkspaceEntry:
        """Close ``workspace_id`` and keep its state.

        The runner stops, which cancels its lines and closes its
        sessions; the stored sessions, links, history and owner stay, so
        the owner creating the same id later picks them up. No new
        request reaches the closing runner, and the id stays reserved
        until it has stopped, so a create under it never loads state the
        old runner is still writing.

        Args:
            workspace_id (str): id to close.

        Returns:
            WorkspaceEntry: the closed entry.

        Raises:
            KeyError: ``workspace_id`` is not registered.
        """
        removal = self._removals.get(workspace_id)
        if removal is None:
            entry = self._entries.pop(workspace_id)
            removal = asyncio.create_task(self._close(entry))
            self._removals[workspace_id] = removal
        return await asyncio.shield(removal)

    async def _close(self, entry: WorkspaceEntry) -> WorkspaceEntry:
        """Run one close, releasing the id once the runner has stopped.

        Args:
            entry (WorkspaceEntry): the entry being closed.
        """
        try:
            await entry.runner.stop()
        finally:
            del self._removals[entry.id]
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
