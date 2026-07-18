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

import os
from urllib.parse import quote

from mirage.observe.disk_store import DiskObserverStore
from mirage.observe.store import ObserverStore
from mirage.workspace.mount.namespace.disk import DiskNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.session.disk import DiskRecordClient, DiskSessionStore
from mirage.workspace.session.store import SessionStore
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore

DEFAULT_STATE_ROOT = "~/.mirage/state"


class DiskWorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore backed by a directory tree.

    Each workspace is one self-contained directory (delete a workspace
    by removing its folder):

    - ``{root}/workspaces/{ws}/workspace.json`` — metadata record
    - ``{root}/workspaces/{ws}/sessions/{sid}.json`` — session table
    - ``{root}/workspaces/{ws}/namespace.json`` — nodes + user, one JSON
    - ``{root}/workspaces/{ws}/history/<day>/<sid>.jsonl`` — history

    The layout mirrors the S3 store file-for-object; mutable records
    get the same generation-CAS contract via the lockfile protocol
    (O_CREAT|O_EXCL mutex, tmp write, rename(2)), so multiple local
    processes share one workspace with zero infrastructure: a
    CLI-created workspace survives restart like ``git init``. Local
    filesystems only; anything cross-machine belongs on redis or s3.
    """

    def __init__(self,
                 root: str = DEFAULT_STATE_ROOT,
                 *,
                 namespace: WorkspaceStateStore | None = None,
                 observer: WorkspaceStateStore | None = None,
                 workspace: WorkspaceStateStore | None = None) -> None:
        super().__init__(namespace=namespace,
                         observer=observer,
                         workspace=workspace)
        self._root = os.path.expanduser(root)
        self._meta: dict[str, DiskRecordClient] = {}
        self._namespaces: dict[str, DiskNamespaceStore] = {}
        self._observers: dict[str, DiskObserverStore] = {}
        self._sessions: dict[str, DiskSessionStore] = {}

    def _ws_root(self, workspace_id: str) -> str:
        return os.path.join(self._root, "workspaces",
                            quote(workspace_id, safe=""))

    def _meta_client(self, workspace_id: str) -> DiskRecordClient:
        if workspace_id not in self._meta:
            self._meta[workspace_id] = DiskRecordClient(
                self._ws_root(workspace_id), "")
        return self._meta[workspace_id]

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._namespaces:
            self._namespaces[workspace_id] = DiskNamespaceStore(
                self._ws_root(workspace_id))
        return self._namespaces[workspace_id]

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        if workspace_id not in self._observers:
            self._observers[workspace_id] = DiskObserverStore(
                os.path.join(self._ws_root(workspace_id), "history"))
        return self._observers[workspace_id]

    def _make_sessions(self, workspace_id: str) -> SessionStore:
        if workspace_id not in self._sessions:
            self._sessions[workspace_id] = DiskSessionStore(
                self._ws_root(workspace_id))
        return self._sessions[workspace_id]

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        fields, _ = await self._meta_client(workspace_id).get("workspace")
        return fields

    async def _set_meta(self, workspace_id: str,
                        fields: WorkspaceFields) -> None:
        await self._meta_client(workspace_id).put("workspace", fields)

    async def _cas_set_meta(self, workspace_id: str, fields: WorkspaceFields,
                            expected_generation: int) -> bool:
        return await self._meta_client(workspace_id).cas_put(
            "workspace", fields, expected_generation)

    async def _close(self) -> None:
        for ns in self._namespaces.values():
            await ns.close()
        for ob in self._observers.values():
            await ob.close()
        for sess in self._sessions.values():
            await sess.close()
        for meta in self._meta.values():
            await meta.close()
