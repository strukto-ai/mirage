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
from collections.abc import Awaitable, Iterable
from typing import cast

import redis.asyncio as aioredis

from mirage.workspace.mount.namespace.store import NamespaceStore, NodeFields


class RedisNamespaceStore(NamespaceStore):
    """NamespaceStore backed by one Redis hash (path -> JSON fields).

    Symlinks and attribute overlays survive process restarts and are
    visible to any workspace pointed at the same key prefix. Writes are
    single-command (HSET/HDEL) so mutations stay one round trip.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): Namespace prefix for the hash key.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:namespace:",
    ) -> None:
        self._client = aioredis.from_url(url)
        self._key = f"{key_prefix}nodes"
        self._user_key = f"{key_prefix}user"

    async def load(self) -> dict[str, NodeFields]:
        raw = await cast("Awaitable[dict[bytes, bytes]]",
                         self._client.hgetall(self._key))
        return {key.decode(): json.loads(value) for key, value in raw.items()}

    async def set(self, path: str, fields: NodeFields) -> None:
        await cast("Awaitable[int]",
                   self._client.hset(self._key, path, json.dumps(fields)))

    async def delete(self, paths: Iterable[str]) -> None:
        doomed = list(paths)
        if doomed:
            await cast("Awaitable[int]", self._client.hdel(self._key, *doomed))

    async def replace_all(self, entries: dict[str, NodeFields]) -> None:
        pipe = self._client.pipeline()
        pipe.delete(self._key)
        if entries:
            pipe.hset(self._key,
                      mapping={
                          path: json.dumps(fields)
                          for path, fields in entries.items()
                      })
        await pipe.execute()

    async def load_user(self) -> str | None:
        raw = await cast("Awaitable[bytes | None]",
                         self._client.get(self._user_key))
        return raw.decode() if raw is not None else None

    async def set_user(self, user: str) -> None:
        await cast("Awaitable[bool]", self._client.set(self._user_key, user))

    async def clear(self) -> None:
        await self._client.delete(self._key, self._user_key)

    async def close(self) -> None:
        await self._client.aclose()
