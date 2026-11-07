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

from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence

from mirage.shell.console import ConsoleStore
from mirage.workspace.record.types import RecordFields


class ExecutionStore(ABC):
    """Storage seam for one workspace's execution plane: each session's
    job list, each job's console, the workspace's lease, the processes
    each daemon runs in it, and the stops asked of them.

    One daemon runs a workspace's processes at a time, for now: the one
    holding its lease (``lease``). A daemon is one Mirage server or host
    process, named by an id it keeps on disk, so a restarted one takes
    its workspaces back at once. Any other daemon on the store reads the
    workspace and signals what runs there, through the store: it lists
    the jobs and processes, waits on a job's console, and asks the
    holder to stop a process (``request_stop``), but it runs no line
    there while the lease holds. Forwarding a line to the holder comes
    later.

    A session's list is one record, {"next": n, "jobs": {id: job}},
    written under a generation CAS the way the session table is, so two
    daemons that number a job on one session at once never hand out the
    same number. A job's console is a stream the record names; any
    daemon on the same store attaches to it by that name, follows it,
    and ends it to kill the job. A job whose daemon lost the lease with
    no ending was lost with it. Each daemon publishes the processes it
    runs, so every daemon on the store lists them, and the highest pid
    it handed out, so a daemon that takes the lease next numbers past it
    and no pid repeats in the workspace. A daemon that finds another's
    record left behind stops the native runs it lists.

    Subclasses are infra adapters (RAM, Redis); everything above (job
    numbers, waits, kills, hangups) is the table's, mirroring the
    NamespaceStore design.

    Args:
        lease_seconds (float | None): how long a lease lasts past its
            last renewal; None means it holds until released, which
            suits a store only one process reaches.
    """

    def __init__(self, lease_seconds: float | None = None) -> None:
        self.lease_seconds = lease_seconds

    @abstractmethod
    async def load(self, session_id: str) -> RecordFields | None:
        """Read one session's job list; None when never written.

        Args:
            session_id (str): the session.
        """
        raise NotImplementedError

    @abstractmethod
    async def cas_set(
        self, session_id: str, fields: RecordFields, expected_generation: int
    ) -> bool:
        """Write one session's job list iff its generation matches.

        Same contract as NamespaceStore.cas_set: a missing record
        counts as generation 0.

        Args:
            session_id (str): the session.
            fields (RecordFields): the whole list, carrying the bumped
                generation.
            expected_generation (int): generation the caller last saw.

        Returns:
            bool: True when the write landed, False on conflict.
        """
        raise NotImplementedError

    @abstractmethod
    async def delete(self, session_id: str, expected_generation: int) -> bool:
        """Drop one session's job list (the session closed) iff its
        generation matches, so a job another daemon numbered after the
        list was read is never dropped unstopped.

        Args:
            session_id (str): the session.
            expected_generation (int): generation the caller last saw.

        Returns:
            bool: True when the list is gone, False on conflict.
        """
        raise NotImplementedError

    @abstractmethod
    def console(self, name: str) -> ConsoleStore:
        """The console stream a job list names.

        Every call for one name reaches the same stream, so the job's
        daemon writes it and any other daemon reads or ends it.

        Args:
            name (str): the console's name, unique per job.
        """
        raise NotImplementedError

    @abstractmethod
    async def lease(
        self, daemon: str, consoles: Sequence[str] = ()
    ) -> str | None:
        """Take the workspace's lease for a daemon, or keep it another
        lease_seconds, with the consoles of the jobs it runs.

        One call compares and writes, so two daemons that ask at once
        never both hold it. A store that expires consoles pushes their
        expiry out here, so a quiet job keeps its output while its
        daemon holds the lease, and loses it a while after the daemon
        dies with nobody left to end it.

        Args:
            daemon (str): the daemon's id.
            consoles (Sequence[str]): the consoles of the jobs it runs.

        Returns:
            str | None: None when the daemon holds the lease now, else
            the id of the daemon whose lease still holds.
        """
        raise NotImplementedError

    @abstractmethod
    async def holder(self) -> str | None:
        """The daemon whose lease holds, None when none does."""
        raise NotImplementedError

    @abstractmethod
    async def release(self, daemon: str) -> None:
        """Give the lease up, iff the daemon still holds it.

        Args:
            daemon (str): the daemon's id.
        """
        raise NotImplementedError

    @abstractmethod
    async def publish(
        self,
        daemon: str,
        processes: Mapping[str, RecordFields],
        last_pid: int = 0,
    ) -> None:
        """Replace the processes a daemon runs; none drops its record.
        The workspace's highest pid rises to ``last_pid``, never falls.

        A record outlives its daemon's lease, so a daemon that finds it
        left behind still reads what it left running.

        Args:
            daemon (str): the daemon's id.
            processes (Mapping[str, RecordFields]): PID to process.
            last_pid (int): the highest pid the daemon handed out.
        """
        raise NotImplementedError

    @abstractmethod
    async def processes(self) -> dict[str, dict[str, RecordFields]]:
        """Every daemon's published processes: daemon to PID to process."""
        raise NotImplementedError

    @abstractmethod
    async def highest_pid(self) -> int:
        """The highest pid any daemon published for the workspace, 0
        before the first."""
        raise NotImplementedError

    @abstractmethod
    async def request_stop(self, daemon: str, pid: int, signal: int) -> None:
        """Ask a daemon to stop one of its processes.

        Args:
            daemon (str): the daemon running it.
            pid (int): the process.
            signal (int): the signal it is stopped with.
        """
        raise NotImplementedError

    @abstractmethod
    async def take_stops(self, daemon: str) -> list[tuple[int, int]]:
        """The stops asked of a daemon since it last took them, as
        (PID, signal) pairs; taking them clears them.

        Args:
            daemon (str): the daemon's id.
        """
        raise NotImplementedError

    @abstractmethod
    async def clear(self) -> None:
        """Delete every job list, console, lease and process record."""
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        """Release any held connections."""
        raise NotImplementedError
