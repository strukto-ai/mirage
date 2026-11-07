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

from mirage.execution.types import LineId


class LineState(str, Enum):
    WAITING = "waiting"
    RUNNING = "running"
    STOPPING = "stopping"
    EXITED = "exited"


@dataclass(frozen=True, slots=True)
class Line:
    """One line a session's shell read: ``waiting`` for its session,
    ``running`` once the session admits it, ``stopping`` once something
    asked it to stop, and ``exited`` when it ends.

    ``ended_at`` is set exactly when ``state`` is final, with ``exit`` its
    status, ``signal`` the signal a stop ended it with, if one did, and
    ``error`` why Mirage could not run it, if it could not.
    """

    id: LineId
    session_id: str
    command: str
    started_at: float
    state: LineState = LineState.WAITING
    ended_at: float | None = None
    exit: int | None = None
    signal: int | None = None
    error: str | None = None
