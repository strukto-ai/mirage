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
import time
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from mirage.io.types import IOResult
from mirage.shell.console import JobConsole
from mirage.workspace.types import ExecutionNode


class JobStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    KILLED = "killed"


@dataclass
class Job:
    """One background command, and everything it has printed.

    Output lives in ``console`` rather than in byte fields, so a reader
    can watch a job while it runs instead of waiting for it to end.
    """

    id: int
    command: str
    task: asyncio.Task[Any] | None
    cwd: str
    status: JobStatus = JobStatus.RUNNING
    exit_code: int = 0
    console: JobConsole = field(default_factory=JobConsole)
    execution_node: ExecutionNode | None = None
    io_result: IOResult | None = None
    created_at: float = field(default_factory=time.time)
    agent: str = "unknown"
    session_id: str = ""


JobRunner = Callable[[Job], Coroutine[Any, Any, tuple[IOResult,
                                                      ExecutionNode]]]

ConsoleFactory = Callable[[int], JobConsole]
