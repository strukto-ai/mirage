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
from collections.abc import Mapping, Sequence

from mirage.shell.console import ConsoleStore, RAMConsoleStore
from mirage.shell.job_table.store import JobStore
from mirage.workspace.record.types import RecordFields, generation_of


def _console_names(fields: RecordFields | None) -> set[str]:
    """The consoles a job list names, its disowned jobs' included.

    Args:
        fields (RecordFields | None): the list, or None.
    """
    if fields is None:
        return set()
    listed = {job["console"] for job in fields.get("jobs", {}).values()}
    return listed | set(fields.get("disowned", {}))


class RAMJobStore(JobStore):
    """JobStore held in process memory (the default).

    Workspaces that share one provider in a process share their jobs
    through it, from any thread: a sync workspace runs its loop on a
    thread of its own, so a list is compared and written under a lock.
    A console is dropped once no list names it; a reader already holding
    it keeps reading, as a console outlives its entry.

    Args:
        lease_seconds (float | None): see JobStore; None by default,
            since every owner here shares the process.
    """

    def __init__(self, lease_seconds: float | None = None) -> None:
        super().__init__(lease_seconds)
        self._lists: dict[str, RecordFields] = {}
        self._consoles: dict[str, RAMConsoleStore] = {}
        self._leases: dict[str, float] = {}
        self._processes: dict[str, dict[str, RecordFields]] = {}
        self._stops: dict[str, list[tuple[int, int]]] = {}
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

    def console(self, name: str) -> ConsoleStore:
        return self._consoles.setdefault(name, RAMConsoleStore())

    async def renew(self, owner: str, consoles: Sequence[str] = ()) -> None:
        if self.lease_seconds is not None:
            self._leases[owner] = time.monotonic() + self.lease_seconds

    async def alive(self, owner: str) -> bool:
        if self.lease_seconds is None:
            return True
        return self._leases.get(owner, 0.0) > time.monotonic()

    async def publish(
        self, owner: str, processes: Mapping[str, RecordFields]
    ) -> None:
        with self._lock:
            if processes:
                self._processes[owner] = copy.deepcopy(dict(processes))
            else:
                self._processes.pop(owner, None)
                self._stops.pop(owner, None)

    async def processes(self) -> dict[str, dict[str, RecordFields]]:
        with self._lock:
            return copy.deepcopy(self._processes)

    async def request_stop(self, owner: str, pid: int, signal: int) -> None:
        with self._lock:
            self._stops.setdefault(owner, []).append((pid, signal))

    async def take_stops(self, owner: str) -> list[tuple[int, int]]:
        with self._lock:
            return self._stops.pop(owner, [])

    async def clear(self) -> None:
        self._lists.clear()
        self._consoles.clear()
        self._leases.clear()
        self._processes.clear()
        self._stops.clear()

    async def close(self) -> None:
        pass

    def _drop(self, names: set[str]) -> None:
        for name in names:
            self._consoles.pop(name, None)
