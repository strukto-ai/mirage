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

from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from mirage.execution.process.handle import ProcessHandle
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
    can watch a job while it runs instead of waiting for it to end. A
    ``simple`` job is one simple command, which the job is, so a program
    it ran that handled a ``kill`` leaves the job its own status. Its
    ``owner`` is the job table that runs it; a job another workspace
    runs has no ``process`` here. Its ``console_name`` is the name its
    job store keeps the console under, which tells apart two jobs a
    reused number gave the same id. A ``reported`` job's shell printed
    the report of the signal that ended it, so ``jobs`` and a ``%N`` no
    longer name it, and its pid still answers ``wait``.
    """

    id: int
    command: str
    cwd: str
    created_at: float
    status: JobStatus = JobStatus.RUNNING
    exit_code: int = 0
    console: JobConsole = field(default_factory=JobConsole)
    session_id: str = ""
    process: ProcessHandle | None = None
    simple: bool = False
    owner: str = ""
    console_name: str = ""
    reported: bool = False

    @property
    def process_id(self) -> str | None:
        """The id of the process the job runs as, as text: its runner's
        here, its console's for a job restored or run elsewhere."""
        return (
            str(self.process.record.id)
            if self.process is not None
            else self.console.process
        )

    @property
    def pid(self) -> int:
        """The managed PID `$!`, `jobs -p` and `wait -p` report.

        A job restored from a snapshot or run by another workspace has
        no runner here, so its job number stands in.
        """
        return self.process.record.pid if self.process is not None else self.id


JobRunner = Callable[
    [Job], Coroutine[Any, Any, tuple[IOResult, ExecutionNode]]
]
