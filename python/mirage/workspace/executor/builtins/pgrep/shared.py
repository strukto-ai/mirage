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

from mirage.context import current_caller
from mirage.execution.job import JobTable
from mirage.execution.process.types import Process, ProcessState
from mirage.workspace.executor.builtins.jobspec import grants_of, session_of
from mirage.workspace.executor.builtins.machine_view import (
    MachineScope,
    in_scope,
)
from mirage.workspace.session import SessionState

# The longest process name a process's ``comm`` holds.
NAME_WIDTH = 15


def program_of(info: Process) -> str:
    """The basename of the program a process runs.

    Args:
        info (Process): the process.
    """
    words = info.command.split()
    return words[0].rsplit("/", 1)[-1] if words else ""


def process_name(info: Process) -> str:
    """A process's name, as the kernel keeps it: its program's basename,
    cut to ``NAME_WIDTH``.

    Args:
        info (Process): the process.
    """
    return program_of(info)[:NAME_WIDTH]


async def running(
    job_table: JobTable, session: SessionState | None, scope: MachineScope
) -> list[Process]:
    """The processes a search picks from, on the machines looked at
    first: those ``ps`` shows, running, on a machine in ``scope`` or,
    unless another machine was named, Mirage's own, without the one searching
    and the shells it runs under, whose lines hold no program's name.

    Args:
        job_table (JobTable): the workspace's jobs.
        session (SessionState | None): the shell session.
        scope (MachineScope): the machines.
    """
    processes = job_table.processes
    await processes.scan()
    caller = current_caller().process
    own = (
        {caller.record.pid, *caller.record.ancestors}
        if caller is not None
        else set()
    )
    return [
        info
        for info in processes.visible(session_of(session), grants_of(session))
        if not info.stages
        and info.pid not in own
        and info.state == ProcessState.RUNNING
        and in_scope(scope, info.shown_machine)
    ]
