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

from mirage.observe.store import ObserverStore, RAMObserverStore
from mirage.workspace.mount.namespace import NamespaceStore, RAMNamespaceStore
from mirage.workspace.session.ram import RAMSessionStore
from mirage.workspace.session.store import SessionStore
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore


class RAMWorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore held in process memory (the default).

    Durability equals the process lifetime; snapshots remain the only
    persistence. Redis-backed workspaces pass a RedisWorkspaceStateStore
    instead and survive restarts / share state across processes.
    """

    def __init__(self, **overrides: "WorkspaceStateStore | None") -> None:
        super().__init__(**overrides)
        self._namespaces: dict[str, RAMNamespaceStore] = {}
        self._observers: dict[str, RAMObserverStore] = {}
        self._sessions: dict[str, RAMSessionStore] = {}
        self._meta: dict[str, WorkspaceFields] = {}

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._namespaces:
            self._namespaces[workspace_id] = RAMNamespaceStore()
        return self._namespaces[workspace_id]

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        if workspace_id not in self._observers:
            self._observers[workspace_id] = RAMObserverStore()
        return self._observers[workspace_id]

    def _make_sessions(self, workspace_id: str) -> SessionStore:
        if workspace_id not in self._sessions:
            self._sessions[workspace_id] = RAMSessionStore()
        return self._sessions[workspace_id]

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        fields = self._meta.get(workspace_id)
        return dict(fields) if fields is not None else None

    async def _set_meta(self, workspace_id: str,
                        fields: WorkspaceFields) -> None:
        self._meta[workspace_id] = dict(fields)

    async def _close(self) -> None:
        pass
