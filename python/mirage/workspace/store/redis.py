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

import hashlib
import json
import os
from typing import Any, Awaitable, cast

import redis.asyncio as aioredis

from mirage.observe.store import ObserverStore
from mirage.shell.job_table.redis import RedisJobStore
from mirage.shell.job_table.store import JobStore
from mirage.workspace.mount.namespace.redis import (
    CAS_SCRIPT,
    RedisNamespaceStore,
)
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore
from mirage.workspace.store.disk import (
    DEFAULT_STATE_ROOT,
    DiskWorkspaceStateStore,
)


def _history_root(root: str, url: str, key_prefix: str) -> str:
    """Where a Redis store keeps its history on disk: a folder of its
    own under ``root``, named by a hash of its url and key prefix, so no
    two stores share one and the url's credentials never reach a path.

    Args:
        root (str): the state root.
        url (str): the store's Redis url.
        key_prefix (str): the store's key prefix.
    """
    digest = hashlib.sha256(f"{url}\n{key_prefix}".encode()).hexdigest()
    return os.path.join(root, "redis", digest[:16])


class RedisWorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore backed by one Redis server.

    Key layout under one prefix, everything scoped by workspace id:

    - ``{prefix}workspaces`` — hash, workspace id -> metadata JSON
    - ``{prefix}{ws}:namespace:nodes`` — node table
    - ``{prefix}{ws}:sessions`` — session table
    - ``{prefix}{ws}:jobs:*``: job lists, consoles and owner leases

    All plane state survives restarts and is visible to every process
    pointed at the same url and prefix, so a workspace rebuilt from its
    config alone gets identical overlays, sessions, and grants, and sees
    the jobs every other one runs. History only grows, so it stays out
    of Redis: on this machine's disk, in a folder of this store's own
    under ``root``, unless ``observer`` names another store.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:",
        *,
        root: str = DEFAULT_STATE_ROOT,
        namespace: WorkspaceStateStore | None = None,
        observer: WorkspaceStateStore | None = None,
        workspace: WorkspaceStateStore | None = None,
        jobs: WorkspaceStateStore | None = None,
    ) -> None:
        super().__init__(
            namespace=namespace,
            observer=observer
            if observer is not None
            else DiskWorkspaceStateStore(
                root=_history_root(root, url, key_prefix)
            ),
            workspace=workspace,
            jobs=jobs,
        )
        self._url = url
        self._prefix = key_prefix
        self._meta_client = aioredis.from_url(url)
        self._meta_key = f"{key_prefix}workspaces"
        # Same generic hash-field CAS the session table uses: the meta
        # hash is keyed by workspace id instead of session id.
        self._meta_cas = self._meta_client.register_script(CAS_SCRIPT)
        self._namespaces: dict[str, RedisNamespaceStore] = {}
        self._sessions: dict[str, RedisNamespaceStore] = {}
        self._jobs: dict[str, RedisJobStore] = {}

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._namespaces:
            self._namespaces[workspace_id] = RedisNamespaceStore(
                url=self._url,
                key_prefix=f"{self._prefix}{workspace_id}:namespace:",
            )
        return self._namespaces[workspace_id]

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        raise RuntimeError(
            "The redis store keeps no history; it goes to the observer "
            "override, disk by default"
        )

    def _make_sessions(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._sessions:
            self._sessions[workspace_id] = RedisNamespaceStore(
                url=self._url,
                key_prefix=f"{self._prefix}{workspace_id}:",
                table="sessions",
            )
        return self._sessions[workspace_id]

    def _make_jobs(self, workspace_id: str) -> JobStore:
        if workspace_id not in self._jobs:
            self._jobs[workspace_id] = RedisJobStore(
                url=self._url,
                key_prefix=f"{self._prefix}{workspace_id}:jobs:",
            )
        return self._jobs[workspace_id]

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        raw = await cast(
            Awaitable[Any],
            self._meta_client.hget(self._meta_key, workspace_id),
        )
        return json.loads(raw) if raw is not None else None

    async def _cas_set_meta(
        self,
        workspace_id: str,
        fields: WorkspaceFields,
        expected_generation: int,
    ) -> bool:
        result = await self._meta_cas(
            keys=[self._meta_key],
            args=[
                workspace_id,
                json.dumps(fields),
                expected_generation,
            ],
        )
        return bool(result)

    async def _forget(self, workspace_id: str) -> None:
        for handles in (
            self._namespaces,
            self._sessions,
            self._jobs,
        ):
            handle = handles.pop(workspace_id, None)
            if handle is not None:
                await handle.close()
        await cast(
            Awaitable[Any],
            self._meta_client.hdel(self._meta_key, workspace_id),
        )

    async def _close(self) -> None:
        for ns in self._namespaces.values():
            await ns.close()
        for sess in self._sessions.values():
            await sess.close()
        for jobs in self._jobs.values():
            await jobs.close()
        await self._meta_client.aclose()
