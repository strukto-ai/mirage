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

import copy
import threading
import time
from collections.abc import Hashable, Mapping, Sequence
from typing import TypeVar

from mirage.execution.base import ExecutionStore
from mirage.execution.constants import HISTORY_MAX_RECORDS, HISTORY_SECONDS
from mirage.execution.line.types import Line
from mirage.execution.process.types import Process
from mirage.execution.types import LineId, ProcessId
from mirage.shell.console import ConsoleStore, RAMConsoleStore
from mirage.workspace.record.types import RecordFields, generation_of

K = TypeVar("K", bound=Hashable)
R = TypeVar("R", Line, Process)


def _console_names(fields: RecordFields | None) -> set[str]:
    """The consoles a job list names, its disowned jobs' included.

    Args:
        fields (RecordFields | None): the list, or None.
    """
    if fields is None:
        return set()
    listed = {job["console"] for job in fields.get("jobs", {}).values()}
    return listed | set(fields.get("disowned", {}))


def _keep(
    records: dict[K, R],
    ends: dict[K, float],
    key: K,
    record: R,
    ended_at: float | None,
) -> None:
    """Put a record in place of the one before, and drop the ended ones
    past the history: beyond ``HISTORY_MAX_RECORDS``, or ended
    ``HISTORY_SECONDS`` before this one, oldest ended first.

    Args:
        records (dict[K, R]): the records, by key.
        ends (dict[K, float]): the ended ones' ends, in the order they
            ended.
        key (K): the record's key.
        record (R): the record.
        ended_at (float | None): when it ended; None while it runs.
    """
    records[key] = record
    ends.pop(key, None)
    if ended_at is None:
        return
    ends[key] = ended_at
    cutoff = ended_at - HISTORY_SECONDS
    while ends:
        oldest, at = next(iter(ends.items()))
        if len(ends) <= HISTORY_MAX_RECORDS and at > cutoff:
            break
        del ends[oldest]
        records.pop(oldest, None)


class RAMExecutionStore(ExecutionStore):
    """ExecutionStore held in process memory (the default).

    Workspaces that share one provider in a process share their jobs
    through it, from any thread: a sync workspace runs its loop on a
    thread of its own, so a list and the lease are compared and written
    under a lock. A console is dropped once no list names it; a reader
    already holding it keeps reading, as a console outlives its entry.

    Args:
        lease_seconds (float | None): see ExecutionStore; None by default,
            since the one process holding the store cannot die apart
            from it, so the lease holds until its workspace closes.
    """

    def __init__(self, lease_seconds: float | None = None) -> None:
        super().__init__(lease_seconds)
        self._lists: dict[str, RecordFields] = {}
        self._consoles: dict[str, RAMConsoleStore] = {}
        self._holder: str | None = None
        self._expires = 0.0
        self._highest = 0
        self._processes: dict[str, dict[str, RecordFields]] = {}
        self._stops: dict[str, list[tuple[int, int]]] = {}
        self._lines: dict[LineId, Line] = {}
        self._line_ends: dict[LineId, float] = {}
        self._records: dict[int, Process] = {}
        self._record_ends: dict[int, float] = {}
        self._lock = threading.Lock()

    async def load(self, session_id: str) -> RecordFields | None:
        fields = self._lists.get(session_id)
        return copy.deepcopy(fields) if fields is not None else None

    async def cas_set(
        self, session_id: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        written = copy.deepcopy(fields)
        with self._lock:
            stored = self._lists.get(session_id)
            if generation_of(stored) != expected_generation:
                return False
            self._lists[session_id] = written
            self._drop(_console_names(stored) - _console_names(fields))
        return True

    async def delete(self, session_id: str, expected_generation: int) -> bool:
        with self._lock:
            stored = self._lists.get(session_id)
            if generation_of(stored) != expected_generation:
                return False
            self._lists.pop(session_id, None)
            self._drop(_console_names(stored))
        return True

    async def sessions(self) -> list[str]:
        with self._lock:
            return sorted(self._lists)

    def note(self, record: Line | Process) -> None:
        with self._lock:
            if isinstance(record, Line):
                _keep(
                    self._lines,
                    self._line_ends,
                    record.id,
                    record,
                    record.ended_at,
                )
            else:
                _keep(
                    self._records,
                    self._record_ends,
                    record.pid,
                    record,
                    record.ended_at,
                )

    async def get_line(self, line_id: LineId) -> Line | None:
        with self._lock:
            return self._lines.get(line_id)

    async def get_process(self, process_id: ProcessId) -> Process | None:
        with self._lock:
            return self._records.get(process_id.pid)

    async def find_lines(self, session_id: str | None = None) -> list[Line]:
        with self._lock:
            lines = list(self._lines.values())
        return sorted(
            (
                line
                for line in lines
                if session_id is None or line.session_id == session_id
            ),
            key=lambda line: line.started_at,
        )

    async def find_processes(
        self, session_id: str | None = None
    ) -> list[Process]:
        with self._lock:
            records = list(self._records.values())
        return sorted(
            (
                record
                for record in records
                if session_id is None or record.session_id == session_id
            ),
            key=lambda record: record.pid,
        )

    def console(self, name: str) -> ConsoleStore:
        return self._consoles.setdefault(name, RAMConsoleStore())

    async def lease(
        self, daemon: str, consoles: Sequence[str] = ()
    ) -> str | None:
        now = time.monotonic()
        with self._lock:
            if self._holder is not None and self._holder != daemon:
                if self.lease_seconds is None or self._expires > now:
                    return self._holder
            self._holder = daemon
            if self.lease_seconds is not None:
                self._expires = now + self.lease_seconds
        return None

    async def holder(self) -> str | None:
        with self._lock:
            if self._holder is None or (
                self.lease_seconds is not None
                and self._expires <= time.monotonic()
            ):
                return None
            return self._holder

    async def release(self, daemon: str) -> None:
        with self._lock:
            if self._holder == daemon:
                self._holder = None

    async def publish(
        self,
        daemon: str,
        processes: Mapping[str, RecordFields],
        last_pid: int = 0,
    ) -> None:
        with self._lock:
            self._highest = max(self._highest, last_pid)
            if processes:
                self._processes[daemon] = copy.deepcopy(dict(processes))
            else:
                self._processes.pop(daemon, None)
                self._stops.pop(daemon, None)

    async def processes(self) -> dict[str, dict[str, RecordFields]]:
        with self._lock:
            return copy.deepcopy(self._processes)

    async def highest_pid(self) -> int:
        return self._highest

    async def request_stop(self, daemon: str, pid: int, signal: int) -> None:
        with self._lock:
            self._stops.setdefault(daemon, []).append((pid, signal))

    async def take_stops(self, daemon: str) -> list[tuple[int, int]]:
        with self._lock:
            return self._stops.pop(daemon, [])

    async def clear(self) -> None:
        self._lists.clear()
        self._consoles.clear()
        self._holder = None
        self._highest = 0
        self._processes.clear()
        self._stops.clear()
        self._lines.clear()
        self._line_ends.clear()
        self._records.clear()
        self._record_ends.clear()

    async def close(self) -> None:
        pass

    def _drop(self, names: set[str]) -> None:
        for name in names:
            self._consoles.pop(name, None)
