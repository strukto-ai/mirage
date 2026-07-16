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

import json
from typing import Awaitable, cast

import redis.asyncio as aioredis

from mirage.observe.redis_store import RedisObserverStore
from mirage.observe.store import ObserverStore
from mirage.workspace.mount.namespace.redis import RedisNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.session.redis import RedisSessionStore
from mirage.workspace.session.store import SessionStore
from mirage.workspace.store.base import WorkspaceFields, WorkspaceStateStore


class RedisWorkspaceStateStore(WorkspaceStateStore):
    """WorkspaceStateStore backed by one Redis server.

    Key layout under one prefix, everything scoped by workspace id:

    - ``{prefix}workspaces`` — hash, workspace id -> metadata JSON
    - ``{prefix}{ws}:namespace:nodes`` (+ ``:user``) — namespace plane
    - ``{prefix}{ws}:observer:*`` — observer plane
    - ``{prefix}{ws}:sessions`` — session table

    All plane state survives restarts and is visible to every process
    pointed at the same url and prefix, so a workspace rebuilt from its
    config alone gets identical overlays, history, sessions, and
    grants.
    """

    def __init__(self,
                 url: str = "redis://localhost:6379/0",
                 key_prefix: str = "mirage:",
                 **overrides: "WorkspaceStateStore | None") -> None:
        super().__init__(**overrides)
        self._url = url
        self._prefix = key_prefix
        self._meta_client = aioredis.from_url(url)
        self._meta_key = f"{key_prefix}workspaces"
        self._namespaces: dict[str, RedisNamespaceStore] = {}
        self._observers: dict[str, RedisObserverStore] = {}
        self._sessions: dict[str, RedisSessionStore] = {}

    def _make_namespace(self, workspace_id: str) -> NamespaceStore:
        if workspace_id not in self._namespaces:
            self._namespaces[workspace_id] = RedisNamespaceStore(
                url=self._url,
                key_prefix=f"{self._prefix}{workspace_id}:namespace:")
        return self._namespaces[workspace_id]

    def _make_observer(self, workspace_id: str) -> ObserverStore:
        if workspace_id not in self._observers:
            self._observers[workspace_id] = RedisObserverStore(
                url=self._url,
                key_prefix=f"{self._prefix}{workspace_id}:observer:")
        return self._observers[workspace_id]

    def _make_sessions(self, workspace_id: str) -> SessionStore:
        if workspace_id not in self._sessions:
            self._sessions[workspace_id] = RedisSessionStore(
                url=self._url, key_prefix=f"{self._prefix}{workspace_id}:")
        return self._sessions[workspace_id]

    async def _load_meta(self, workspace_id: str) -> WorkspaceFields | None:
        raw = await cast(Awaitable,
                         self._meta_client.hget(self._meta_key, workspace_id))
        return json.loads(raw) if raw is not None else None

    async def _set_meta(self, workspace_id: str,
                        fields: WorkspaceFields) -> None:
        await cast(
            Awaitable,
            self._meta_client.hset(self._meta_key, workspace_id,
                                   json.dumps(fields)))

    async def _close(self) -> None:
        for ns in self._namespaces.values():
            await ns.close()
        for ob in self._observers.values():
            await ob.close()
        for sess in self._sessions.values():
            await sess.close()
        await self._meta_client.aclose()
