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
from collections.abc import Awaitable, Mapping, Sequence
from importlib.resources import files
from typing import cast

import redis.asyncio as aioredis

from mirage.execution.base import ExecutionStore
from mirage.execution.job.constants import (
    CONSOLE_TTL_SECONDS,
    LEASE_SECONDS,
)
from mirage.shell.console.redis import RedisConsoleStore
from mirage.workspace.mount.namespace.redis import CAS_SCRIPT
from mirage.workspace.record.types import RecordFields

LEASE_SCRIPT = (files("mirage.execution") / "lease.lua").read_text(
    encoding="utf-8"
)
PID_SCRIPT = (files("mirage.execution") / "pid.lua").read_text(
    encoding="utf-8"
)


class RedisExecutionStore(ExecutionStore):
    """ExecutionStore on one Redis server, shared by every process on it.

    Key layout under one prefix:

    - ``{prefix}lists``: a hash of session id to job list JSON, written
      with the session table's compare-and-set script
    - ``{prefix}console:{name}:*``: one console stream per job
      (``RedisConsoleStore``), expiring a day after its last write or
      the last renewal of the lease while its job ran
    - ``{prefix}lease``: the id of the daemon holding the workspace's
      lease, a key that expires, taken and released by ``lease.lua``
    - ``{prefix}pid``: the highest pid published, raised by ``pid.lua``
    - ``{prefix}processes:{id}``: the processes a daemon runs, as JSON,
      kept a day after its last publish so the runs of one that lost
      the lease can still be found
    - ``{prefix}stops:{id}``: a list of the stops asked of a daemon

    One client serves the lists, the lease and every console, so a
    workspace holds one connection pool however many jobs it follows.

    Args:
        url (str): Redis connection URL.
        key_prefix (str): namespace for the plane's keys.
        lease_seconds (float | None): see ``ExecutionStore``.
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
        self._lease = f"{key_prefix}lease"
        self._pid = f"{key_prefix}pid"
        self._cas = self._client.register_script(CAS_SCRIPT)
        self._lease_script = self._client.register_script(LEASE_SCRIPT)
        self._pid_script = self._client.register_script(PID_SCRIPT)
        self._raised = 0

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

    async def delete(self, session_id: str, expected_generation: int) -> bool:
        result = await self._cas(
            keys=[self._lists], args=[session_id, "", expected_generation]
        )
        return bool(result)

    def console(self, name: str) -> RedisConsoleStore:
        return RedisConsoleStore(
            url=self._url,
            key_prefix=f"{self._prefix}console:{name}:",
            ttl_seconds=CONSOLE_TTL_SECONDS,
            client=self._client,
        )

    async def lease(
        self, daemon: str, consoles: Sequence[str] = ()
    ) -> str | None:
        """One round trip with no consoles to keep, and one pipeline
        however many jobs the daemon runs, so the lease is never late
        behind its consoles."""
        expiry = (
            str(int(self.lease_seconds * 1000))
            if self.lease_seconds is not None
            else ""
        )
        args = [daemon, "take", expiry]
        if not consoles:
            held = await self._lease_script(keys=[self._lease], args=args)
        else:
            pipe = self._client.pipeline(transaction=False)
            await self._lease_script(
                keys=[self._lease], args=args, client=pipe
            )
            for name in consoles:
                for key in self.console(name).keys:
                    pipe.expire(key, CONSOLE_TTL_SECONDS)
            held = (await pipe.execute())[0]
        return held.decode() if held is not None else None

    async def holder(self) -> str | None:
        held = await self._client.get(self._lease)
        return held.decode() if held is not None else None

    async def release(self, daemon: str) -> None:
        await self._lease_script(
            keys=[self._lease], args=[daemon, "release", ""]
        )

    async def publish(
        self,
        daemon: str,
        processes: Mapping[str, RecordFields],
        last_pid: int = 0,
    ) -> None:
        key = f"{self._prefix}processes:{daemon}"
        if last_pid > self._raised:
            await self._pid_script(keys=[self._pid], args=[last_pid])
            self._raised = last_pid
        if processes:
            await self._client.set(
                key, json.dumps(dict(processes)), ex=CONSOLE_TTL_SECONDS
            )
        else:
            await self._client.delete(key, f"{self._prefix}stops:{daemon}")

    async def processes(self) -> dict[str, dict[str, RecordFields]]:
        head = f"{self._prefix}processes:"
        keys = [key async for key in self._client.scan_iter(f"{head}*")]
        if not keys:
            return {}
        values = await self._client.mget(keys)
        return {
            key.decode()[len(head) :]: json.loads(value)
            for key, value in zip(keys, values)
            if value is not None
        }

    async def highest_pid(self) -> int:
        return int(await self._client.get(self._pid) or 0)

    async def request_stop(self, daemon: str, pid: int, signal: int) -> None:
        key = f"{self._prefix}stops:{daemon}"
        pipe = self._client.pipeline(transaction=False)
        pipe.rpush(key, json.dumps([pid, signal]))
        pipe.expire(key, CONSOLE_TTL_SECONDS)
        await pipe.execute()

    async def take_stops(self, daemon: str) -> list[tuple[int, int]]:
        key = f"{self._prefix}stops:{daemon}"
        pipe = self._client.pipeline(transaction=True)
        pipe.lrange(key, 0, -1)
        pipe.delete(key)
        raw, _ = await pipe.execute()
        return [(int(pid), int(sig)) for pid, sig in map(json.loads, raw)]

    async def clear(self) -> None:
        keys = [
            key async for key in self._client.scan_iter(f"{self._prefix}*")
        ]
        if keys:
            await self._client.delete(*keys)
        self._raised = 0

    async def close(self) -> None:
        await self._client.aclose()
