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

from datetime import datetime, timedelta, timezone

from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.commands.spec.standard import version_line
from mirage.execution.job import JobTable
from mirage.execution.types import MachineResources
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    machine_scope,
    option_refusal,
    read_machines,
    usage_page,
    with_machine,
)
from mirage.workspace.executor.builtins.resources import constants
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _plural(count: int) -> str:
    """What follows a noun for ``count`` of it.

    Args:
        count (int): how many.
    """
    return "" if count == 1 else "s"


def up_text(seconds: float) -> str:
    """How long a machine has been up, as ``uptime`` and ``top`` say it.

    Args:
        seconds (float): its uptime.
    """
    whole = int(seconds)
    days, rest = divmod(whole, 86400)
    hours, rest = divmod(rest, 3600)
    minutes = rest // 60
    clock = f"{hours:2d}:{minutes:02d}" if hours else f"{minutes} min"
    if not days:
        return clock
    return f"{days} day{_plural(days)}, {clock}"


def summary(row: MachineResources) -> str:
    """What ``uptime`` and ``top``'s first line share: how long the
    machine has been up, its users and its load.

    Args:
        row (MachineResources): what it holds.
    """
    one, five, fifteen = row.load
    return (
        f"{row.clock} up {up_text(row.up_seconds)},  "
        f"{row.users} user{_plural(row.users)},  "
        f"load average: {one:.2f}, {five:.2f}, {fifteen:.2f}"
    )


def pretty(seconds: float) -> str:
    """``uptime -p``: each part of the time that is not zero, and the
    minutes always.

    Args:
        seconds (float): its uptime.
    """
    left = int(seconds)
    parts: list[str] = []
    for name, size in constants.PRETTY_UNITS:
        amount, left = divmod(left, size)
        if amount:
            parts.append(f"{amount} {name}{_plural(amount)}")
    minutes = left // 60
    parts.append(f"{minutes} minute{_plural(minutes)}")
    return "up " + ", ".join(parts)


def since(row: MachineResources) -> str:
    """``uptime -s``: when the machine booted, on its own clock.

    Args:
        row (MachineResources): what it holds.
    """
    sign = -1 if row.offset.startswith("-") else 1
    digits = row.offset.lstrip("+-")
    offset = timedelta(
        minutes=sign * (int(digits[:2]) * 60 + int(digits[2:4]))
    )
    booted = datetime.fromtimestamp(
        int(row.epoch - row.up_seconds), timezone(offset)
    )
    return booted.strftime("%Y-%m-%d %H:%M:%S")


async def handle_uptime(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Say how long the machines a line can use have been up and how
    loaded they are, ``machine_scope`` choosing which; several print a
    line each with the machine at its end. ``-s`` outranks ``-p``.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``uptime`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    parse = parse_shell_options(SHELL_SPECS["uptime"], parts[1:])
    refusal = option_refusal("uptime", parse)
    if refusal:
        return job_result(cmd_str, refusal, 1)
    if parse.operands:
        return job_result(cmd_str, f"\n{usage_page('uptime')}", 1)
    if parse.flags.get("h") is True:
        return (
            encode_text(usage_page("uptime")),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if parse.flags.get("V") is True:
        return (
            version_line("uptime"),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    name = parse.flags.get("machine")
    named = name if isinstance(name, str) else None
    processes = job_table.processes
    scope = machine_scope(processes, named)
    if scope is None:
        return job_result(cmd_str, f"uptime: {named}: no such machine\n", 1)
    rows, errors = await read_machines(processes, scope, "uptime")
    lines: list[str] = []
    for row in rows:
        if parse.flags.get("s") is True:
            text = since(row)
        elif parse.flags.get("p") is True:
            text = pretty(row.up_seconds)
        else:
            text = f" {summary(row)}"
        lines.append(
            with_machine(text, row.machine) if scope.several else text
        )
    code = 1 if errors else 0
    err = encode_text(errors) or None
    return (
        encode_text("".join(f"{line}\n" for line in lines)),
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
