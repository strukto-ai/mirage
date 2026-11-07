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

from mirage.execution.types import JobId


class JobState(str, Enum):
    RUNNING = "running"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class Job:
    """One background job, as every daemon on its store reads it: what
    a ``cmd &`` started, numbered ``%N`` in its session's list.

    A job a ``kill`` reached is ``stopping`` until its runner stops.
    ``ended_at`` is set exactly when ``state`` is final, with ``exit`` the
    status ``wait`` answers and ``signal`` the signal a kill or a hangup
    ended it with, if one did.
    """

    id: JobId
    number: int
    session_id: str
    command: str
    cwd: str
    started_at: float
    state: JobState = JobState.RUNNING
    ended_at: float | None = None
    exit: int | None = None
    signal: int | None = None
