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
from collections.abc import Awaitable, Sequence
from typing import Any, cast

import redis.asyncio as aioredis

from mirage.shell.console.redis import RedisConsoleStore
from mirage.shell.job_table.constants import (
    CONSOLE_TTL_SECONDS,
    LEASE_SECONDS,
)
from mirage.shell.job_table.store import JobStore
from mirage.workspace.mount.namespace.redis import CAS_SCRIPT
from mirage.workspace.record.types import RecordFields


class RedisJobStore(JobStore):
    """JobStore on one Redis server, shared by every process on it.

    Key layout under one prefix:

    - ``{prefix}lists``: a hash of session id to job list JSON, written
      with the session table's compare-and-set script
    - ``{prefix}console:{name}:*``: one console stream per job
      (``RedisConsoleStore``), expiring a day after its last write or
      its owner's last renewal
    - ``{prefix}owner:{id}``: an owner's lease, a key that expires

    One client serves the lists, the leases and every console, so a
    workspace holds one connection pool however many jobs it follows.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): namespace for the plane's keys.
        lease_seconds (float | None): see ``JobStore``.
    """

    def __init__(
        self,
        url: str = "redis://localhost:6379/0",
        key_prefix: str = "mirage:jobs:",
        lease_seconds: float | None = LEASE_SECONDS,
    ) -> None:
        super().__init__(lease_seconds)
        self._url = url
        self._prefix = key_prefix
        self._client = aioredis.from_url(url)
        self._lists = f"{key_prefix}lists"
        self._cas = self._client.register_script(CAS_SCRIPT)

    async def load(self, session_id: str) -> RecordFields | None:
        raw = await cast(
            "Awaitable[bytes | None]",
            self._client.hget(self._lists, session_id),
        )
        return json.loads(raw) if raw is not None else None

    async def cas_set(
        self, session_id: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        result = await self._cas(
            keys=[self._lists],
            args=[session_id, json.dumps(fields), expected_generation],
        )
        return bool(result)

    async def delete(self, session_id: str) -> None:
        await cast(
            "Awaitable[Any]", self._client.hdel(self._lists, session_id)
        )

    def console(self, name: str) -> RedisConsoleStore:
        return RedisConsoleStore(
            url=self._url,
            key_prefix=f"{self._prefix}console:{name}:",
            ttl_seconds=CONSOLE_TTL_SECONDS,
            client=self._client,
        )

    async def renew(self, owner: str, consoles: Sequence[str] = ()) -> None:
        """One round trip however many jobs the owner runs, so the lease
        is never late behind its consoles."""
        pipe = self._client.pipeline(transaction=False)
        if self.lease_seconds is not None:
            pipe.set(
                f"{self._prefix}owner:{owner}",
                b"1",
                px=int(self.lease_seconds * 1000),
            )
        for name in consoles:
            for key in self.console(name).keys:
                pipe.expire(key, CONSOLE_TTL_SECONDS)
        await pipe.execute()

    async def alive(self, owner: str) -> bool:
        if self.lease_seconds is None:
            return True
        return bool(await self._client.exists(f"{self._prefix}owner:{owner}"))

    async def clear(self) -> None:
        keys = [
            key async for key in self._client.scan_iter(f"{self._prefix}*")
        ]
        if keys:
            await self._client.delete(*keys)

    async def close(self) -> None:
        await self._client.aclose()
