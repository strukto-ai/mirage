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
from mirage.vfs.sql.types import SqlDriver
from mirage.workspace.mount.namespace.store import (
    NamespaceStore,
    RecordNamespaceStore,
)
from mirage.workspace.record.sql import SqlRecordClient
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore
from mirage.workspace.store.ram import RAMWorkspaceStateStore


class SqlWorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore hosting the sessions, the metadata record and
    the namespace nodes in a SQLite-dialect database, as
    ``mirage_records`` rows:

    - ``{scope}workspaces/`` — metadata, one record per workspace
    - ``{scope}{ws}/sessions/`` — the session table
    - ``{scope}{ws}/nodes/`` — symlinks and the attribute overlay

    So a workspace whose process restarts on the same file keeps its
    sessions' cwd, exported env and functions, and its links. Observer
    events and jobs are per-process planes and stay in memory. Mirrors
    TypeScript's ``SqlWorkspaceStateStore``.
    """

    def __init__(
        self,
        driver: SqlDriver,
        *,
        scope: str = "",
        owns_driver: bool = False,
        namespace: WorkspaceStateStore | None = None,
        observer: WorkspaceStateStore | None = None,
        workspace: WorkspaceStateStore | None = None,
        jobs: WorkspaceStateStore | None = None,
    ) -> None:
        """Args:
        driver (SqlDriver): the database the records live in.
        scope (str): scopes every record, so many workspaces' stores
            share one database.
        owns_driver (bool): whether closing the store closes ``driver``;
            a passed driver is borrowed by default.
        namespace (WorkspaceStateStore | None): serves the namespace
            plane instead.
        observer (WorkspaceStateStore | None): serves the observer plane
            instead.
        workspace (WorkspaceStateStore | None): serves the metadata and
            sessions instead.
        jobs (WorkspaceStateStore | None): serves the jobs plane instead.
        """
        super().__init__(
            namespace=namespace,
            observer=observer,
            workspace=workspace,
            jobs=jobs,
        )
        self._driver = driver
        self._scope = scope
        self._owns_driver = owns_driver
        self._meta = SqlRecordClient(driver, f"{scope}workspaces/")
        self._memory = RAMWorkspaceStateStore()
        self._tables: dict[str, RecordNamespaceStore] = {}

    def _table(self, workspace_id: str, plane: str) -> RecordNamespaceStore:
        scope = f"{self._scope}{workspace_id}/{plane}/"
        if scope not in self._tables:
            self._tables[scope] = RecordNamespaceStore(
                SqlRecordClient(self._driver, scope)
            )
        return self._tables[scope]

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        return self._table(workspace_id, "nodes")

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        return self._memory.observer(workspace_id)

    def _make_sessions(self, workspace_id: str) -> NamespaceStore:
        return self._table(workspace_id, "sessions")

    def _make_jobs(self, workspace_id: str) -> JobStore:
        return self._memory.jobs(workspace_id)

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
        for plane in ("nodes", "sessions"):
            self._tables.pop(f"{self._scope}{workspace_id}/{plane}/", None)
        await self._meta.delete([workspace_id])
        await self._memory.drop(workspace_id)

    async def _close(self) -> None:
        await self._memory.close()
        if self._owns_driver:
            self._driver.close()
