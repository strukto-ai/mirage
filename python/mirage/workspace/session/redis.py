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

from mirage.workspace.session.store import SessionFields, SessionStore


class RedisSessionStore(SessionStore):
    """SessionStore backed by one Redis hash (session id -> JSON fields).

    Sessions and the mount grants they carry survive restarts and are
    visible to every workspace pointed at the same key prefix — the
    seam that lets one process create a session and another (a kernel
    tier, a sibling daemon) bind a mountpoint to it. Writes are
    single-command (HSET/HDEL) so mutations stay one round trip.
    """

    def __init__(self,
                 url: str = "redis://localhost:6379/0",
                 key_prefix: str = "mirage:session:") -> None:
        self._client = aioredis.from_url(url)
        self._key = f"{key_prefix}sessions"

    async def load(self) -> dict[str, SessionFields]:
        raw = await cast(Awaitable, self._client.hgetall(self._key))
        return {key.decode(): json.loads(value) for key, value in raw.items()}

    async def set(self, session_id: str, fields: SessionFields) -> None:
        await cast(
            Awaitable,
            self._client.hset(self._key, session_id, json.dumps(fields)))

    async def delete(self, session_ids: Iterable[str]) -> None:
        ids = list(session_ids)
        if not ids:
            return
        await cast(Awaitable, self._client.hdel(self._key, *ids))

    async def replace_all(self, entries: dict[str, SessionFields]) -> None:
        pipe = self._client.pipeline(transaction=True)
        pipe.delete(self._key)
        if entries:
            pipe.hset(self._key,
                      mapping={
                          sid: json.dumps(fields)
                          for sid, fields in entries.items()
                      })
        await pipe.execute()

    async def clear(self) -> None:
        await cast(Awaitable, self._client.delete(self._key))

    async def close(self) -> None:
        await self._client.aclose()
