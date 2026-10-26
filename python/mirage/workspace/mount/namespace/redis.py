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
from importlib.resources import files
from typing import cast

import redis.asyncio as aioredis

from mirage.workspace.mount.namespace.store import NamespaceStore
from mirage.workspace.record.types import RecordFields

CAS_SCRIPT = (files("mirage.workspace.mount.namespace") / "cas.lua").read_text(
    encoding="utf-8"
)


class RedisNamespaceStore(NamespaceStore):
    """NamespaceStore backed by one Redis hash (key -> JSON fields).

    Symlinks, attribute overlays, sessions and the mount grants they
    carry survive process restarts and are visible to any workspace
    pointed at the same key prefix, which is what lets a kernel tier
    bind a session-bound mountpoint another daemon created. Writes are
    single-command (HSET/HDEL, or one Lua compare-and-set) so mutations
    stay one round trip.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): Namespace prefix for the hash key.
        table (str): the hash's name under the prefix.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:namespace:",
        table: str = "nodes",
    ) -> None:
        self._client = aioredis.from_url(url)
        self._key = f"{key_prefix}{table}"
        self._cas = self._client.register_script(CAS_SCRIPT)

    async def load(self) -> dict[str, RecordFields]:
        raw = await cast(
            "Awaitable[dict[bytes, bytes]]", self._client.hgetall(self._key)
        )
        return {key.decode(): json.loads(value) for key, value in raw.items()}

    async def set(self, key: str, fields: RecordFields) -> None:
        await cast(
            "Awaitable[int]",
            self._client.hset(self._key, key, json.dumps(fields)),
        )

    async def cas_set(
        self, key: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        result = await self._cas(
            keys=[self._key],
            args=[key, json.dumps(fields), expected_generation],
        )
        return bool(result)

    async def delete(self, keys: Iterable[str]) -> None:
        doomed = list(keys)
        if doomed:
            await cast("Awaitable[int]", self._client.hdel(self._key, *doomed))

    async def replace_all(self, entries: dict[str, RecordFields]) -> None:
        pipe = self._client.pipeline()
        pipe.delete(self._key)
        if entries:
            pipe.hset(
                self._key,
                mapping={
                    key: json.dumps(fields) for key, fields in entries.items()
                },
            )
        await pipe.execute()

    async def clear(self) -> None:
        await self._client.delete(self._key)

    async def close(self) -> None:
        await self._client.aclose()
