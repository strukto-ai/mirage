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

import asyncio
import json
import logging
import threading
from collections.abc import Awaitable, Mapping, Sequence
from importlib.resources import files
from typing import cast

import redis.asyncio as aioredis

from mirage.execution.base import ExecutionStore
from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.job.constants import (
    CONSOLE_TTL_SECONDS,
    LEASE_SECONDS,
)
from mirage.execution.line.types import Line
from mirage.execution.process.types import Process
from mirage.execution.serde import (
    line_from_fields,
    line_to_fields,
    process_from_fields,
    process_to_fields,
)
from mirage.execution.types import LineId, ProcessId
from mirage.shell.console.redis import RedisConsoleStore
from mirage.workspace.mount.namespace.redis import CAS_SCRIPT
from mirage.workspace.record.types import RecordFields

logger = logging.getLogger(__name__)

LEASE_SCRIPT = (files("mirage.execution") / "lease.lua").read_text(
    encoding="utf-8"
)
PID_SCRIPT = (files("mirage.execution") / "pid.lua").read_text(
    encoding="utf-8"
)
HISTORY_SCRIPT = (files("mirage.execution") / "history.lua").read_text(
    encoding="utf-8"
)


def _field_of(record: Line | Process) -> tuple[bool, str]:
    """Whether a record is a line, and the hash field it is kept under.

    Args:
        record (Line | Process): the record.
    """
    if isinstance(record, Line):
        return True, record.id.value
    return False, str(record.pid)


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
    - ``{prefix}records:lines`` and ``{prefix}records:processes``: a hash
      of id to record JSON, written by ``history.lua``, which keeps each
      kind's ended ones in ``{prefix}ended:lines`` and
      ``{prefix}ended:processes``, sorted sets by end, trimmed to the
      history; both expire a day after their last write

    One client serves the lists, the lease and every console, so a
    workspace holds one connection pool however many jobs it follows.
    Records are written in the background, in batches, the newest of
    each winning; ``close`` writes what is left.

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
        self._history = self._client.register_script(HISTORY_SCRIPT)
        self._raised = 0
        self._lines_key = f"{key_prefix}records:lines"
        self._processes_key = f"{key_prefix}records:processes"
        self._pending: dict[tuple[bool, str], Line | Process] = {}
        self._pending_lock = threading.Lock()
        self._writing = False
        self._writer: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

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

    def note(self, record: Line | Process) -> None:
        with self._pending_lock:
            self._pending[_field_of(record)] = record
            if self._writing:
                return
            self._writing = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            if self._loop is None or self._loop.is_closed():
                with self._pending_lock:
                    self._writing = False
                return
            self._loop.call_soon_threadsafe(self._write_soon)
            return
        self._loop = loop
        self._write_soon()

    def _write_soon(self) -> None:
        self._writer = asyncio.ensure_future(self._write_pending())

    async def _write_pending(self) -> None:
        """Write the records noted since the last batch, until none are
        left; a batch that fails is logged and dropped."""
        while True:
            with self._pending_lock:
                batch, self._pending = self._pending, {}
                if not batch:
                    self._writing = False
                    return
            try:
                pipe = self._client.pipeline(transaction=False)
                for (is_line, field), record in batch.items():
                    fields = (
                        line_to_fields(record)
                        if isinstance(record, Line)
                        else process_to_fields(record)
                    )
                    kind = "lines" if is_line else "processes"
                    await self._history(
                        keys=[
                            f"{self._prefix}records:{kind}",
                            f"{self._prefix}ended:{kind}",
                        ],
                        args=[
                            field,
                            json.dumps(fields),
                            ""
                            if record.ended_at is None
                            else repr(record.ended_at),
                            HISTORY_MAX_RECORDS,
                            HISTORY_SECONDS,
                            CONSOLE_TTL_SECONDS,
                        ],
                        client=pipe,
                    )
                await pipe.execute()
            except Exception as exc:
                logger.debug("execution records not written: %s", exc)

    async def _flush(self) -> None:
        """Wait for the records noted so far to be written."""
        writer = self._writer
        if writer is not None and not writer.done():
            await writer
        with self._pending_lock:
            if self._writing or not self._pending:
                return
            self._writing = True
        await self._write_pending()

    def _noted(self, is_line: bool) -> list[Line | Process]:
        """The records noted but not written yet, of one kind.

        Args:
            is_line (bool): lines rather than processes.
        """
        with self._pending_lock:
            return [
                record
                for (line, _), record in self._pending.items()
                if line == is_line
            ]

    async def get_line(self, line_id: LineId) -> Line | None:
        with self._pending_lock:
            noted = self._pending.get((True, line_id.value))
        if isinstance(noted, Line):
            return noted
        raw = await cast(
            "Awaitable[bytes | None]",
            self._client.hget(self._lines_key, line_id.value),
        )
        return line_from_fields(json.loads(raw)) if raw is not None else None

    async def get_process(self, process_id: ProcessId) -> Process | None:
        field = str(process_id.pid)
        with self._pending_lock:
            noted = self._pending.get((False, field))
        if isinstance(noted, Process):
            return noted
        raw = await cast(
            "Awaitable[bytes | None]",
            self._client.hget(self._processes_key, field),
        )
        return (
            process_from_fields(json.loads(raw)) if raw is not None else None
        )

    async def find_lines(self, session_id: str | None = None) -> list[Line]:
        raw = await cast(
            "Awaitable[dict[bytes, bytes]]",
            self._client.hgetall(self._lines_key),
        )
        found = {
            line.id: line
            for line in (line_from_fields(json.loads(v)) for v in raw.values())
        }
        for noted in self._noted(True):
            if isinstance(noted, Line):
                found[noted.id] = noted
        return sorted(
            (
                line
                for line in found.values()
                if session_id is None or line.session_id == session_id
            ),
            key=lambda line: line.started_at,
        )

    async def find_processes(
        self, session_id: str | None = None
    ) -> list[Process]:
        raw = await cast(
            "Awaitable[dict[bytes, bytes]]",
            self._client.hgetall(self._processes_key),
        )
        found = {
            record.pid: record
            for record in (
                process_from_fields(json.loads(v)) for v in raw.values()
            )
        }
        for noted in self._noted(False):
            if isinstance(noted, Process):
                found[noted.pid] = noted
        return sorted(
            (
                record
                for record in found.values()
                if session_id is None or record.session_id == session_id
            ),
            key=lambda record: record.pid,
        )

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
        await self._flush()
        keys = [
            key async for key in self._client.scan_iter(f"{self._prefix}*")
        ]
        if keys:
            await self._client.delete(*keys)
        self._raised = 0

    async def close(self) -> None:
        await self._flush()
        await self._client.aclose()
