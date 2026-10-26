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

from mirage.observe.store import ObserverStore
from mirage.shell.job_table.store import JobStore
from mirage.vfs.s3.config import S3Config
from mirage.workspace.mount.namespace.store import (
    NamespaceStore,
    RecordNamespaceStore,
)
from mirage.workspace.record.s3 import S3RecordClient
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore


class S3WorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore hosting the sessions + metadata group on S3.

    Object layout under one bucket and prefix:

    - ``{prefix}workspaces/{ws}.json`` — metadata record
    - ``{prefix}{ws}/sessions/{session_id}.json`` — session table

    Every record write is CAS-gated by a conditional PUT anchored on
    the compare-read's ETag, giving S3 the same generation contract as
    the Redis Lua script; bucket versioning (when enabled) doubles as
    an audit trail for free. This store hosts only the sessions+meta
    group: namespace nodes and observer events are chatty per-op
    planes that belong on RAM or Redis, so use this store as the
    ``workspace`` group override of a RAM or Redis default store.
    """

    def __init__(
        self, config: S3Config, **overrides: "WorkspaceStateStore | None"
    ) -> None:
        super().__init__(**overrides)
        self._config = config
        self._prefix = config.key_prefix or ""
        self._meta = S3RecordClient(config, f"{self._prefix}workspaces/")
        self._sessions: dict[str, RecordNamespaceStore] = {}

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        raise RuntimeError(
            "The s3 store hosts only the sessions+meta group; keep the "
            "namespace plane on ram or redis and pass the s3 store as "
            "the 'workspace' group override."
        )

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        raise RuntimeError(
            "The s3 store hosts only the sessions+meta group; keep the "
            "observer plane on ram or redis and pass the s3 store as "
            "the 'workspace' group override."
        )

    def _make_jobs(self, workspace_id: str) -> JobStore:
        raise RuntimeError(
            "The s3 store hosts only the sessions+meta group; keep the "
            "jobs plane on ram or redis and pass the s3 store as the "
            "'workspace' group override."
        )

    def _make_sessions(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._sessions:
            self._sessions[workspace_id] = RecordNamespaceStore(
                S3RecordClient(
                    self._config, f"{self._prefix}{workspace_id}/sessions/"
                )
            )
        return self._sessions[workspace_id]

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        fields, _ = await self._meta.get(workspace_id)
        return fields

    async def _cas_set_meta(
        self,
        workspace_id: str,
        fields: WorkspaceFields,
        expected_generation: int,
    ) -> bool:
        return await self._meta.cas_put(
            workspace_id, fields, expected_generation
        )

    async def _forget(self, workspace_id: str) -> None:
        handle = self._sessions.pop(workspace_id, None)
        if handle is not None:
            await handle.close()
        await self._meta.delete([workspace_id])

    async def _close(self) -> None:
        for sess in self._sessions.values():
            await sess.close()
        await self._meta.close()
