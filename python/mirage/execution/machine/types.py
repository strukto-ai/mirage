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

from dataclasses import dataclass
from enum import Enum

from mirage.execution.types import MachineId


class MachineState(str, Enum):
    """How far Mirage reaches a machine, as its last check found it.

    ``managed``: the check reached it, and Mirage sees and stops every
    process its programs start there: it has ``/proc`` and the ``sh``,
    ``tr`` and ``grep`` the scan runs, or it is the workspace's own host.
    ``reachable``: the check reached it, but Mirage sees and stops only
    what it started itself.
    ``unreachable``: the last check failed.
    """

    MANAGED = "managed"
    REACHABLE = "reachable"
    UNREACHABLE = "unreachable"


@dataclass(frozen=True, slots=True)
class Machine:
    """One machine a workspace runs programs on, as its last check found
    it: ``checked_at`` is when that check ran.
    """

    id: MachineId
    state: MachineState
    checked_at: float


@dataclass(frozen=True, slots=True)
class MachineProcess:
    """One process a scan found that a workspace's run started: ``tag``
    is the Mirage process the run is, ``pid`` and ``ppid`` its own and
    its parent's pid on the machine, ``started`` when it started (clock
    ticks after boot on a machine, epoch seconds on the host), which
    tells it apart from a later process given the same pid, ``args``
    its arguments, space separated, ``state`` the letter ``ps`` shows for
    it, and ``program`` the pid of the program its run reported, None
    while it has reported none.
    """

    tag: str
    pid: int
    ppid: int
    started: float
    args: str
    state: str = "R"
    program: int | None = None
