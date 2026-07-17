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

import time
from abc import ABC, abstractmethod
from typing import Any

from mirage.observe.store import ObserverStore
from mirage.workspace.mount.namespace import NamespaceStore
from mirage.workspace.session.store import (CAS_MAX_RETRIES, SessionStore,
                                            generation_of)

# One workspace's metadata record: the JSON-able discovery payload
# (workspace_id, default_session_id, created_at, generation). This is
# what another process reads to find a workspace's sessions and its
# default session before binding to it.
WorkspaceFields = dict[str, Any]


class WorkspaceStateStore(ABC):
    """Provider for a workspace's whole control-plane state.

    One store, four planes, each scoped by workspace id: namespace
    nodes (symlinks, attribute overlays), observer events (command
    history), the session table (mount grants, cwd, env), and the
    workspace metadata record (discovery: which sessions exist, which
    is the default). Handing two processes the same store config plus a
    workspace id gives them the same workspace state, which is the seam
    that lets a kernel tier bind a session-bound mountpoint created by
    another daemon.

    The planes keep their existing narrow interfaces (NamespaceStore,
    ObserverStore, SessionStore); this provider only unifies their
    construction, connection, and key scoping. Per-group overrides
    redirect a plane group to a different provider (e.g. large observer
    logs to disk while everything else stays on Redis). Sessions and
    metadata form one inseparable group: the default-session pointer in
    the metadata must never live on a different server than the session
    table it points into.
    """

    def __init__(self,
                 *,
                 namespace: "WorkspaceStateStore | None" = None,
                 observer: "WorkspaceStateStore | None" = None,
                 workspace: "WorkspaceStateStore | None" = None) -> None:
        self._namespace_override = namespace
        self._observer_override = observer
        self._workspace_override = workspace

    def namespace(self, workspace_id: str) -> NamespaceStore:
        """The namespace plane (nodes) for one workspace."""
        target = self._namespace_override or self
        return target._make_namespace(workspace_id)

    def observer(self, workspace_id: str) -> ObserverStore:
        """The observer plane (history events) for one workspace."""
        target = self._observer_override or self
        return target._make_observer(workspace_id)

    def sessions(self, workspace_id: str) -> SessionStore:
        """The session table for one workspace."""
        target = self._workspace_override or self
        return target._make_sessions(workspace_id)

    async def load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        """Read one workspace's metadata record; None when never written."""
        target = self._workspace_override or self
        return await target._load_meta(workspace_id)

    async def set_meta(self, workspace_id: str,
                       fields: WorkspaceFields) -> None:
        """Insert or update one workspace's metadata record."""
        target = self._workspace_override or self
        await target._set_meta(workspace_id, fields)

    async def cas_set_meta(self, workspace_id: str, fields: WorkspaceFields,
                           expected_generation: int) -> bool:
        """Write the metadata record iff its stored generation matches.

        Same optimistic-concurrency contract as SessionStore.cas_set: a
        missing record (and a legacy record without the field) counts as
        generation 0, so create-if-absent is ``expected_generation=0``.
        Returns True when the write landed, False on conflict.
        """
        target = self._workspace_override or self
        return await target._cas_set_meta(workspace_id, fields,
                                          expected_generation)

    async def replace_meta(self, workspace_id: str,
                           fields: WorkspaceFields) -> WorkspaceFields:
        """CAS-write ``fields`` over the stored record, retrying on
        conflict.

        Ours-wins content (snapshot restore semantics): each attempt
        merges ``fields`` over the stored record, preserves the stored
        ``created_at``, bumps the generation, and retries when another
        writer got there first. Returns the record as written.
        """
        for _ in range(CAS_MAX_RETRIES):
            existing = await self.load_meta(workspace_id)
            stored = existing if existing is not None else {}
            expected = generation_of(existing)
            merged = {
                **stored,
                **fields,
                "created_at": stored.get("created_at", time.time()),
                "generation": expected + 1,
            }
            if await self.cas_set_meta(workspace_id, merged, expected):
                return merged
        raise RuntimeError(f"workspace {workspace_id!r} meta kept "
                           "conflicting with another writer")

    async def close(self) -> None:
        """Release connections held by this provider and its overrides."""
        for override in (self._namespace_override, self._observer_override,
                         self._workspace_override):
            if override is not None:
                await override.close()
        await self._close()

    @abstractmethod
    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        """Construct (or return the cached) namespace store for a workspace."""

    @abstractmethod
    def _make_observer(self, workspace_id: str) -> ObserverStore:
        """Construct (or return the cached) observer store for a workspace."""

    @abstractmethod
    def _make_sessions(self, workspace_id: str) -> SessionStore:
        """Construct (or return the cached) session store for a workspace."""

    @abstractmethod
    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        """Backend read of one metadata record."""

    @abstractmethod
    async def _set_meta(self, workspace_id: str,
                        fields: WorkspaceFields) -> None:
        """Backend write of one metadata record."""

    @abstractmethod
    async def _cas_set_meta(self, workspace_id: str, fields: WorkspaceFields,
                            expected_generation: int) -> bool:
        """Backend conditional write of one metadata record."""

    @abstractmethod
    async def _close(self) -> None:
        """Release this provider's own connections."""
