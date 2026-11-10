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
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace

from mirage.commands.builtin.constants import CPUS
from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.commands.spec.standard import version_line
from mirage.execution.job import JobTable
from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.execution.process.table import ProcessTable
from mirage.execution.types import MachineResources
from mirage.io import IOResult
from mirage.io.memory import MemoryBudget, memory_budget
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import job_result
from mirage.workspace.executor.builtins.machine_view import (
    MACHINE_HEADER,
    MachineScope,
    machine_scope,
    option_refusal,
    read_machines,
    usage_page,
    with_machine,
)
from mirage.workspace.executor.builtins.resources import constants
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


@dataclass(frozen=True, slots=True)
class FreeOptions:
    """How ``free`` prints.

    Args:
        power (int): the unit's power of its base.
        si (bool): the base is 1000.
        human (bool): ``-h``.
        wide (bool): ``-w``.
        total (bool): ``-t``.
        committed (bool): ``-v``.
        lohi (bool): ``-l``.
        line (bool): ``-L``.
        blank (bool): print ``-`` for every figure.
    """

    power: int
    si: bool
    human: bool
    wide: bool
    total: bool
    committed: bool
    lohi: bool
    line: bool
    blank: bool = False


def one_decimal(value: float) -> str:
    """One decimal, an exact tie going to the even digit as printf
    rounds it.

    Args:
        value (float): the number.
    """
    return f"{value:.1f}"


def human_size(size: int, si: bool) -> str:
    """A size as ``free -h`` prints it: the smallest unit that fits in
    three characters, with one decimal if that fits and the whole number,
    cut short, if only that does.

    Args:
        size (int): the size in bytes.
        si (bool): the base is 1000.
    """
    base = 1000 if si else 1024
    if size < base:
        return f"{size}B"
    tail = "" if si else "i"
    for power, unit in enumerate(constants.HUMAN_UNITS, start=1):
        scaled = size / base**power
        text = one_decimal(scaled)
        if len(text) <= constants.HUMAN_DIGITS:
            return f"{text}{unit}{tail}"
        whole = str(size // base**power)
        if len(whole) <= constants.HUMAN_DIGITS:
            return f"{whole}{unit}{tail}"
    return f"{size // base ** len(constants.HUMAN_UNITS)}"


def _cell(size: int | None, options: FreeOptions) -> str:
    """One figure as the options print it.

    Args:
        size (int | None): the figure in bytes; None for none.
        options (FreeOptions): how to print.
    """
    if size is None or options.blank:
        return constants.NO_FIGURE
    if options.human:
        return human_size(size, options.si)
    return str(size // (1000 if options.si else 1024) ** options.power)


def _row(label: str, cells: list[str]) -> str:
    """One row of the table.

    Args:
        label (str): the row's label.
        cells (list[str]): its columns.
    """
    return f"{label:<{constants.FREE_LABEL_WIDTH}}" + "".join(
        f"{cell:>{constants.FREE_FIRST_WIDTH if at == 0 else constants.FREE_WIDTH}}"
        for at, cell in enumerate(cells)
    )


def _header(options: FreeOptions) -> str:
    """The table's header.

    Args:
        options (FreeOptions): how to print.
    """
    names = ["total", "used", "free", "shared"]
    names += ["buffers", "cache"] if options.wide else ["buff/cache"]
    return _row("", [*names, "available"])


def _both(first: int | None, second: int | None) -> int | None:
    """Two figures together, None if the machine has neither.

    Args:
        first (int | None): one figure.
        second (int | None): the other.
    """
    if first is None and second is None:
        return None
    return (first or 0) + (second or 0)


def _table(row: MachineResources, options: FreeOptions) -> list[str]:
    """One machine's rows.

    Args:
        row (MachineResources): what it holds.
        options (FreeOptions): how to print.
    """
    used = row.mem_total - row.mem_available
    swap_used = row.swap_total - row.swap_free

    def cells(*sizes: int | None) -> list[str]:
        return [_cell(size, options) for size in sizes]

    cached = (
        [row.buffers, row.cached]
        if options.wide
        else [_both(row.buffers, row.cached)]
    )
    rows = [
        _row(
            "Mem:",
            cells(
                row.mem_total,
                used,
                row.mem_free,
                row.shared,
                *cached,
                row.mem_available,
            ),
        )
    ]
    if options.lohi:
        low_total = (
            row.low_total if row.low_total is not None else row.mem_total
        )
        low_free = row.low_free if row.low_free is not None else row.mem_free
        high_total = row.high_total or 0
        high_free = row.high_free or 0
        rows.append(
            _row("Low:", cells(low_total, low_total - low_free, low_free))
        )
        rows.append(
            _row("High:", cells(high_total, high_total - high_free, high_free))
        )
    rows.append(_row("Swap:", cells(row.swap_total, swap_used, row.swap_free)))
    if options.total:
        rows.append(
            _row(
                "Total:",
                cells(
                    row.mem_total + row.swap_total,
                    used + swap_used,
                    row.mem_free + row.swap_free,
                ),
            )
        )
    if options.committed:
        limit = row.commit_limit
        committed = row.committed
        rows.append(
            _row(
                "Comm:",
                cells(
                    limit,
                    committed,
                    None
                    if limit is None or committed is None
                    else limit - committed,
                ),
            )
        )
    return rows


def _one_line(row: MachineResources, options: FreeOptions) -> str:
    """One machine's ``-L`` line.

    Args:
        row (MachineResources): what it holds.
        options (FreeOptions): how to print.
    """
    width = constants.FREE_WIDTH - 1
    swap = _cell(row.swap_total - row.swap_free, options)
    cache = _cell(_both(row.buffers, row.cached), options)
    used = _cell(row.mem_total - row.mem_available, options)
    free = _cell(row.mem_free, options)
    return (
        f"SwapUse {swap:>{width}} CachUse {cache:>{width}}  "
        f"MemUse {used:>{width}} MemFree {free:>{width}} "
    )


def _workspace_row(memory: MemoryBudget | None) -> MachineResources:
    """The workspace's own row: its ``max_memory``, what it holds of
    that and what is left, and never a figure of the server it runs on.
    With no ``max_memory`` it has no size to say (``_shown``).

    Args:
        memory (MemoryBudget | None): its budget, None for no cap.
    """
    limit = 0 if memory is None else memory.limit
    room = 0 if memory is None else memory.room()
    return MachineResources(
        machine=WORKSPACE_MACHINE,
        cpus=CPUS,
        all_cpus=CPUS,
        epoch=0.0,
        clock="",
        offset="",
        up_seconds=0.0,
        load=(0.0, 0.0, 0.0),
        users=0,
        mem_total=limit,
        mem_free=room,
        mem_available=room,
        swap_total=0,
        swap_free=0,
    )


def _shown(row: MachineResources, options: FreeOptions) -> FreeOptions:
    """How one machine's figures print: the workspace's as ``-`` when it
    has no ``max_memory``.

    Args:
        row (MachineResources): what it holds.
        options (FreeOptions): how to print.
    """
    uncapped = row.machine == WORKSPACE_MACHINE and row.mem_total == 0
    return replace(options, blank=True) if uncapped else options


async def _read(
    processes: ProcessTable, scope: MachineScope, memory: MemoryBudget | None
) -> tuple[list[MachineResources], str]:
    """What the scope holds now, the workspace first where it answers.

    Args:
        processes (ProcessTable): the workspace's processes.
        scope (MachineScope): the machines.
        memory (MemoryBudget | None): the workspace's budget.
    """
    rows, errors = await read_machines(processes, scope, "free")
    return [_workspace_row(memory), *rows] if scope.workspace else rows, errors


def _render(
    rows: list[MachineResources], options: FreeOptions, several: bool
) -> str:
    """One pass of output.

    Args:
        rows (list[MachineResources]): what the machines hold.
        options (FreeOptions): how to print.
        several (bool): say which machine each row is about.
    """
    if options.line:
        lines = [
            with_machine(_one_line(row, _shown(row, options)), row.machine)
            if several
            else _one_line(row, _shown(row, options))
            for row in rows
        ]
        return "".join(f"{line}\n" for line in lines)
    header = _header(options)
    width = len(header)
    lines = [f"{header}  {MACHINE_HEADER}" if several else header]
    for row in rows:
        for line in _table(row, _shown(row, options)):
            lines.append(
                with_machine(line, row.machine, width) if several else line
            )
    return "".join(f"{line}\n" for line in lines)


async def _passes(
    first: str,
    processes: ProcessTable,
    scope: MachineScope,
    memory: MemoryBudget | None,
    options: FreeOptions,
    count: int | None,
    delay: float,
) -> AsyncIterator[bytes]:
    """The first pass, then one every ``delay`` until ``count`` are out,
    a blank line between each.

    Args:
        first (str): the first pass, already read.
        processes (ProcessTable): the workspace's processes.
        scope (MachineScope): the machines.
        memory (MemoryBudget | None): the workspace's budget.
        options (FreeOptions): how to print.
        count (int | None): how many passes; None for no end.
        delay (float): the seconds between them.
    """
    yield encode_text(first)
    done = 1
    while count is None or done < count:
        await asyncio.sleep(delay)
        rows, _ = await _read(processes, scope, memory)
        yield encode_text("\n" + _render(rows, options, scope.several))
        done += 1


def _free_options(
    given: list[str], flags: dict[str, str | bool]
) -> FreeOptions:
    """The options a line gave.

    Args:
        given (list[str]): the unit options given.
        flags (dict[str, str | bool]): every option given.
    """
    power, si = constants.FREE_UNITS[given[0]] if given else (1, False)
    return FreeOptions(
        power=power,
        si=si or flags.get("si") is True,
        human=flags.get("h") is True,
        wide=flags.get("w") is True,
        total=flags.get("t") is True,
        committed=flags.get("v") is True,
        lohi=flags.get("l") is True,
        line=flags.get("L") is True,
    )


def _read_delay(text: str) -> tuple[float, str]:
    """The seconds ``-s`` gives, or why it gives none.

    Args:
        text (str): the option's value.
    """
    try:
        seconds = float(text)
    except ValueError:
        return (
            0.0,
            f"free: seconds argument failed: '{text}': Invalid argument\n",
        )
    if seconds <= 0:
        return 0.0, f"free: seconds argument `{text}' is not positive number\n"
    return seconds, ""


def _read_count(text: str) -> tuple[int, str]:
    """The passes ``-c`` gives, or why it gives none.

    Args:
        text (str): the option's value.
    """
    if not (text.isascii() and text.isdigit()):
        return 0, f"free: failed to parse count argument: '{text}'\n"
    if int(text) < 1:
        return 0, (
            f"free: failed to parse count argument: '{text}': "
            "Numerical result out of range\n"
        )
    return int(text), ""


async def handle_free(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the memory of the machines a line can use, in procps's
    columns, ``machine_scope`` choosing which; several print a row each
    with a ``MACHINE`` column on the right, so columns a reader counts
    stay where they are, and are never added up. Figures a machine has
    no such thing for print ``-``. The workspace answers too, in any
    workspace, with its ``max_memory``.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``free`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    parse = parse_shell_options(SHELL_SPECS["free"], parts[1:])
    refusal = option_refusal("free", parse)
    if refusal:
        return job_result(cmd_str, refusal, 1)
    if parse.operands:
        return job_result(cmd_str, f"\n{usage_page('free')}", 1)
    if parse.flags.get("help") is True:
        return (
            encode_text(usage_page("free")),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if parse.flags.get("V") is True:
        return (
            version_line("free"),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    units = [key for key, _ in parse.given if key in constants.FREE_UNITS]
    if len(units) > 1:
        return job_result(
            cmd_str, "free: Multiple unit options don't make sense.\n", 1
        )
    delay = constants.FREE_DELAY_SECONDS
    count: int | None = 1
    if isinstance(parse.flags.get("s"), str):
        delay, said = _read_delay(str(parse.flags["s"]))
        if said:
            return job_result(cmd_str, said, 1)
        count = None
    if isinstance(parse.flags.get("c"), str):
        count, said = _read_count(str(parse.flags["c"]))
        if said:
            return job_result(cmd_str, said, 1)
    name = parse.flags.get("machine")
    named = name if isinstance(name, str) else None
    processes = job_table.processes
    scope = machine_scope(processes, named, workspace=True)
    if scope is None:
        return job_result(cmd_str, f"free: {named}: no such machine\n", 1)
    options = _free_options(units, parse.flags)
    memory = memory_budget()
    rows, errors = await _read(processes, scope, memory)
    text = _render(rows, options, scope.several) if rows else ""
    code = 1 if errors else 0
    err = encode_text(errors) or None
    out: ByteSource = (
        encode_text(text)
        if count == 1
        else _passes(text, processes, scope, memory, options, count, delay)
    )
    return (
        out,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
