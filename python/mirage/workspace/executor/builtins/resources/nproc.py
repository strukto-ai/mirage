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

from mirage.commands.builtin.constants import CPUS
from mirage.commands.builtin.utils.threads import thread_limit
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.shell import parse_shell_options
from mirage.execution.job import JobTable
from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    machine_scope,
    option_refusal,
    read_machines,
    rows_result,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_nproc(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the processors of the workspace and the machines a line
    can use, on a workspace that runs programs on any: one bare number
    for one, as a script expects, and a row each, its number first, for
    several (``machine_scope``). The number is never added up, as one
    program cannot use another machine's processors.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``nproc`` first.
        session (SessionState | None): the shell session, for the
            OpenMP limits.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    parse = parse_shell_options(SPECS["nproc"], parts[1:])
    refusal = option_refusal("nproc", parse, page=False)
    if refusal:
        return job_result(
            cmd_str, f"{refusal}Try 'nproc --help' for more information.\n", 1
        )
    ignore = parse.flags.get("ignore")
    if isinstance(ignore, str) and not (ignore.isascii() and ignore.isdigit()):
        return job_result(
            cmd_str, f"nproc: invalid number: '{quote_text(ignore)}'\n", 1
        )
    if parse.operands:
        return job_result(
            cmd_str,
            f"nproc: extra operand '{quote_text(parse.operands[0])}'\n"
            "Try 'nproc --help' for more information.\n",
            1,
        )
    name = parse.flags.get("machine")
    named = name if isinstance(name, str) else None
    processes = job_table.processes
    scope = machine_scope(processes, named, workspace=True)
    if scope is None:
        return job_result(cmd_str, f"nproc: {named}: no such machine\n", 1)
    rows, errors = await read_machines(processes, scope, "nproc")
    env = session.env if session is not None else {}
    every = parse.flags.get("all") is True
    figures = [(row.machine, row.cpus, row.all_cpus) for row in rows]
    if scope.workspace:
        figures.insert(0, (WORKSPACE_MACHINE, CPUS, CPUS))
    counts = [
        max(
            1,
            (whole if every else thread_limit(env, usable))
            - int(ignore if isinstance(ignore, str) else 0),
        )
        for _, usable, whole in figures
    ]
    width = max((len(str(count)) for count in counts), default=0)
    lines = [
        f"{count:>{width}}  {figure[0]}" if scope.several else str(count)
        for count, figure in zip(counts, figures, strict=True)
    ]
    return rows_result(cmd_str, lines, errors)
