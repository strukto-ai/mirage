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
from typing import Any

from mirage.workspace.session import SessionManager
from mirage.workspace.store import WorkspaceStateStore


class WorkspaceMeta:
    """The workspace's metadata record in the state store.

    Siblings pointed at the same store find a workspace's sessions and
    its default session through this record. It is written once per
    process and an existing record always wins, so attaching to a known
    workspace adopts its stored session pointer rather than the
    provisional id minted at construction.

    Args:
        workspace_id (str): the workspace this record describes.
        store (WorkspaceStateStore): where the record lives.
        sessions (SessionManager): told to adopt an adopted default.
        default_session_id (str): the provisional id minted at
            construction.
        session_id_explicit (bool): the caller named a session, so a
            stored pointer must not override it.
    """

    def __init__(self, workspace_id: str, store: WorkspaceStateStore,
                 sessions: SessionManager, default_session_id: str,
                 session_id_explicit: bool) -> None:
        self._workspace_id = workspace_id
        self._store = store
        self._sessions = sessions
        self._default_session_id = default_session_id
        self._session_id_explicit = session_id_explicit
        self._written = False

    @property
    def default_session_id(self) -> str:
        return self._default_session_id

    async def load(self) -> dict[str, Any]:
        """The record, registering this workspace first if needed."""
        await self.ensure()
        meta = await self._store.load_meta(self._workspace_id)
        return meta if meta is not None else {}

    async def ensure(self) -> None:
        """Write the record once per process.

        An existing record wins (another process or an earlier run of
        this workspace already registered it); a fresh workspace
        registers itself so siblings pointed at the same store can find
        its sessions and default session.
        """
        if self._written:
            return
        existing = await self._store.load_meta(self._workspace_id)
        if existing is None:
            created = await self._store.cas_set_meta(
                self._workspace_id, {
                    "workspace_id": self._workspace_id,
                    "default_session_id": self._default_session_id,
                    "created_at": time.time(),
                    "generation": 1,
                }, 0)
            if not created:
                # Lost the create race: a sibling registered first and
                # its record wins, like any other existing record.
                existing = await self._store.load_meta(self._workspace_id)
        if existing is not None:
            stored = existing.get("default_session_id")
            if not self._session_id_explicit and isinstance(stored, str):
                self._sessions.adopt_default(stored)
                self._default_session_id = stored
        self._written = True
