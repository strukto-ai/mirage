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

from collections.abc import Callable
from dataclasses import dataclass

from mirage.execution.process.child import ChildProcess
from mirage.execution.process.types import SpawnRequest


@dataclass(frozen=True, slots=True)
class SessionProcesses:
    """What a command's handler gets of its session's processes, in
    ``ctx.processes``. ``probe`` answers whether a pid is one the session
    sees, raising PermissionError (EPERM) for one it sees but may not
    stop; ``check_spawn`` refuses once the session this was made for is
    closed or re-profiled; ``spawn`` starts a child and ``depth`` is how
    many spawned processes deep the session runs. It carries no reference
    to mutable tasks.
    """

    check_spawn: Callable[[], None]
    probe: Callable[[int], bool]
    depth: int = 0
    spawn: Callable[[SpawnRequest], ChildProcess] | None = None
