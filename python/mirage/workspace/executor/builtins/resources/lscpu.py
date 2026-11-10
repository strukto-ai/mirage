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
from mirage.execution.job import JobTable
from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.execution.types import MachineResources
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.constants import NOT_FOUND_STATUS
from mirage.shell.voice import shell_voice
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    machine_named,
    machine_scope,
    read_machines,
    rows_result,
)
from mirage.workspace.executor.builtins.resources.constants import (
    LSCPU_VALUE_COLUMN,
    LSCPU_WIDE_ROWS,
    NO_FIGURE,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

CPUS_LABEL = "CPU(s):"

# What the workspace can say of itself, in ``lscpu``'s order: ``od`` and
# Python's ``sys.byteorder`` read bytes little-endian on every host.
WORKSPACE_ROWS = {"Byte Order:": "Little Endian", CPUS_LABEL: str(CPUS)}


def _fields(info: str) -> dict[str, str]:
    """``lscpu``'s rows, by label, less those too wide for a table.

    Args:
        info (str): what it printed.
    """
    fields: dict[str, str] = {}
    for line in info.splitlines():
        label, colon, value = line.partition(":")
        if colon and not line.startswith(LSCPU_WIDE_ROWS):
            fields[f"{label}:"] = value.strip()
    return fields


def _labels(columns: list[dict[str, str]]) -> list[str]:
    """Every label of the columns, each machine's in its own order and
    one a machine alone has placed after the row it follows there.

    Args:
        columns (list[dict[str, str]]): each column's rows.
    """
    labels: list[str] = []
    for column in columns:
        at = 0
        for label in column:
            if label in labels:
                at = labels.index(label) + 1
            else:
                labels.insert(at, label)
                at += 1
    return labels


def _table(rows: list[MachineResources]) -> list[str]:
    """One row a field and one column a machine, the workspace first
    with what it can say of itself and ``-`` for the rest, as it is no
    computer.

    Args:
        rows (list[MachineResources]): the machines that answered.
    """
    heads = [WORKSPACE_MACHINE, *(row.machine for row in rows)]
    columns = [WORKSPACE_ROWS, *(_fields(row.cpu_info) for row in rows)]
    labels = _labels(columns[1:]) or list(WORKSPACE_ROWS)
    table = [
        [label, *(column.get(label, NO_FIGURE) for column in columns)]
        for label in labels
    ]
    every = [["", *heads], *table]
    widths = [max(len(row[at]) for row in every) for at in range(len(heads))]
    return [
        "  ".join(
            [
                *(
                    cell.ljust(w)
                    for cell, w in zip(row[:-1], widths, strict=True)
                ),
                row[-1],
            ]
        ).rstrip()
        for row in every
    ]


async def handle_lscpu(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print what the machines' processors are, on a workspace that runs
    programs on any: ``lscpu`` as a machine prints it for one, as a
    script expects, and for several a table with a column each
    (``machine_scope``). Any other option is the program's own.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``lscpu`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    named = machine_named(parts[1:])
    processes = job_table.processes
    scope = machine_scope(processes, named, workspace=True)
    if scope is None:
        return job_result(cmd_str, f"lscpu: {named}: no such machine\n", 1)
    rows, errors = await read_machines(processes, scope, "lscpu")
    if scope.several:
        return rows_result(cmd_str, _table(rows), errors)
    if scope.workspace:
        lines = [
            f"{label:<{LSCPU_VALUE_COLUMN}}{value}"
            for label, value in WORKSPACE_ROWS.items()
        ]
        return rows_result(cmd_str, lines, errors)
    if rows and not rows[0].cpu_info:
        return job_result(
            cmd_str,
            f"{shell_voice()}lscpu: command not found\n",
            NOT_FOUND_STATUS,
        )
    info = rows[0].cpu_info if rows else ""
    return rows_result(cmd_str, info.splitlines(), errors)
