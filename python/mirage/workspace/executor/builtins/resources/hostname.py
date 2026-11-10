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

from mirage.commands.builtin.constants import HOSTNAME
from mirage.execution.job import JobTable
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    machine_named,
    machine_scope,
    read_machines,
    rows_result,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_hostname(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the workspace's name and each machine's, on a workspace
    that runs programs on any, one name a line and the workspace's
    first (``machine_scope``).

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``hostname`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    named = machine_named(parts[1:])
    processes = job_table.processes
    scope = machine_scope(processes, named, workspace=True)
    if scope is None:
        return job_result(cmd_str, f"hostname: {named}: no such machine\n", 1)
    rows, errors = await read_machines(processes, scope, "hostname")
    names = [HOSTNAME] if scope.workspace else []
    names += [row.hostname for row in rows]
    return rows_result(cmd_str, names, errors)
