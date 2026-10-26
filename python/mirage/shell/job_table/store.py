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
from collections.abc import Sequence

from mirage.shell.console import ConsoleStore
from mirage.workspace.record.types import RecordFields


class JobStore(ABC):
    """Storage seam for the job plane: each session's job list, each
    job's console, and which owners still run their jobs.

    A session's list is one record, {"next": n, "jobs": {id: job}},
    written under a generation CAS the way the session table is, so two
    workspaces that start a job on one session at once never hand out
    the same number. A job's console is a stream the record names; any
    workspace on the same store attaches to it by that name, follows it,
    and ends it to kill the job. A lease says an owner is still alive: a
    job whose owner's lease lapsed with no ending was lost with it.

    Subclasses are infra adapters (RAM, Redis); everything above (job
    numbers, waits, kills, hangups) is the table's, mirroring the
    NamespaceStore design.

    Args:
        lease_seconds (float | None): how long an owner's renewal keeps
            it alive; None means owners never lapse, which holds where
            every owner shares one process.
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
    async def delete(self, session_id: str) -> None:
        """Drop one session's job list (the session closed).

        Args:
            session_id (str): the session.
        """
        raise NotImplementedError

    @abstractmethod
    def console(self, name: str) -> ConsoleStore:
        """The console stream a job list names.

        Every call for one name reaches the same stream, so the job's
        owner writes it and any other workspace reads or ends it.

        Args:
            name (str): the console's name, unique per job.
        """
        raise NotImplementedError

    @abstractmethod
    async def renew(self, owner: str, consoles: Sequence[str] = ()) -> None:
        """Keep an owner alive for another lease_seconds, and the
        consoles of the jobs it still runs with it.

        A store that expires consoles pushes their expiry out here, so a
        quiet job keeps its output while its owner lives, and loses it a
        while after the owner dies with nobody left to end it.

        Args:
            owner (str): the owning job table's id.
            consoles (Sequence[str]): the consoles of the jobs it runs.
        """
        raise NotImplementedError

    @abstractmethod
    async def alive(self, owner: str) -> bool:
        """Whether an owner's lease still holds.

        Args:
            owner (str): the owning job table's id.
        """
        raise NotImplementedError

    @abstractmethod
    async def clear(self) -> None:
        """Delete every job list, console and lease."""
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        """Release any held connections."""
        raise NotImplementedError
