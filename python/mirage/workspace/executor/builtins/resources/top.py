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
from dataclasses import dataclass

from mirage.commands.builtin.utils.identity import UNKNOWN_NAME
from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.context import current_caller
from mirage.execution.job import JobTable
from mirage.execution.process.constants import WORKSPACE_MACHINE
from mirage.execution.process.types import Process, ProcessUsage
from mirage.execution.types import CpuShares, MachineResources, TaskCounts
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import (
    grants_of,
    job_result,
    session_of,
)
from mirage.workspace.executor.builtins.machine_view import (
    MACHINE_HEADER,
    MachineScope,
    machine_scope,
    option_refusal,
    read_machines,
    usage_page,
    with_machine,
)
from mirage.workspace.executor.builtins.ps.constants import STATES
from mirage.workspace.executor.builtins.resources import constants
from mirage.workspace.executor.builtins.resources.uptime import summary
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


@dataclass(frozen=True, slots=True)
class TopOptions:
    """How ``top`` prints.

    Args:
        iterations (int | None): how many frames; None for no end.
        delay (float): the seconds between them.
        full (bool): ``-c``, the whole command line.
        width (int): the line width.
        scale (str): ``-E``'s scale.
        sort (str): the field the rows sort by.
        pids (frozenset[int]): ``-p``'s pids, empty for every one.
        narrowed (bool): ``-w`` was given, which cuts every line.
    """

    iterations: int | None
    delay: float
    full: bool
    width: int
    scale: str
    sort: str
    pids: frozenset[int]
    narrowed: bool = False


NO_USAGE = ProcessUsage(0.0, 0.0, 0.0, 0, 0)


def _count(value: int) -> str:
    """A task count in its column.

    Args:
        value (int): the count.
    """
    return f"{value:3d}"


def _figure(value: float) -> str:
    """A memory figure in its column.

    Args:
        value (float): the figure.
    """
    return f"{value:9.1f}"


def _tasks_line(tasks: TaskCounts | None) -> str:
    """``top``'s ``Tasks:`` line.

    Args:
        tasks (TaskCounts | None): how many there are; None for unknown.
    """
    count = tasks if tasks is not None else TaskCounts(0, 0, 0)
    return (
        f"Tasks: {_count(count.total)} total, "
        f"{_count(count.running)} running, "
        f"{_count(count.sleeping)} sleeping, "
        f"{_count(count.stopped)} stopped, "
        f"{_count(count.zombie)} zombie"
    )


def _share(value: float | None) -> str:
    """One percentage of the ``%Cpu(s):`` line.

    Args:
        value (float | None): the share; None where the machine has
            no such thing.
    """
    return f"{'-':>5}" if value is None else f"{value:5.1f}"


def _cpu_line(cpu: CpuShares | None) -> str:
    """``top``'s ``%Cpu(s):`` line.

    Args:
        cpu (CpuShares | None): where the time went.
    """
    shares = cpu if cpu is not None else CpuShares(0.0, 0.0, 100.0)
    return (
        f"%Cpu(s):{_share(shares.user)} us,{_share(shares.system)} sy,"
        f"{_share(shares.nice)} ni,{_share(shares.idle)} id,"
        f"{_share(shares.wait)} wa,{_share(shares.hardware)} hi,"
        f"{_share(shares.software)} si,{_share(shares.stolen)} st "
    )


def _memory_lines(row: MachineResources, scale: str) -> list[str]:
    """``top``'s memory and swap lines.

    Args:
        row (MachineResources): what the machine holds.
        scale (str): ``-E``'s scale.
    """
    name, unit = constants.TOP_SCALES[scale]
    used = (row.mem_total - row.mem_available) / unit
    cache = ((row.buffers or 0) + (row.cached or 0)) / unit
    swap_used = (row.swap_total - row.swap_free) / unit
    return [
        f"{name} Mem :{_figure(row.mem_total / unit)} total,"
        f"{_figure(row.mem_free / unit)} free,{_figure(used)} used,"
        f"{_figure(cache)} buff/cache     ",
        f"{name} Swap:{_figure(row.swap_total / unit)} total,"
        f"{_figure(row.swap_free / unit)} free,{_figure(swap_used)} used."
        f"{_figure(row.mem_available / unit)} avail Mem ",
    ]


def _block(row: MachineResources, scale: str) -> list[str]:
    """One machine's five summary lines.

    Args:
        row (MachineResources): what it holds.
        scale (str): ``-E``'s scale.
    """
    return [
        f"top - {summary(row)}",
        _tasks_line(row.tasks),
        _cpu_line(row.cpu),
        *_memory_lines(row, scale),
    ]


def _cpu_clock(seconds: float) -> str:
    """``top``'s ``TIME+``: minutes, seconds and hundredths.

    Args:
        seconds (float): the CPU time.
    """
    hundredths = int(seconds * 100)
    minutes, rest = divmod(hundredths, 6000)
    return f"{minutes}:{rest // 100:02d}.{rest % 100:02d}"


def _kib(size: int, width: int) -> str:
    """A size in KiB, in the units that fit its column.

    Args:
        size (int): the size in KiB.
        width (int): the column's width.
    """
    text = str(size)
    if len(text) <= width:
        return text
    for power, unit in enumerate("mgt", start=1):
        text = f"{size / 1024**power:.1f}{unit}"
        if len(text) <= width:
            return text
    return text


def _usage_of(info: Process) -> ProcessUsage:
    """A process's usage, zero where its machine gave none.

    Args:
        info (Process): the process.
    """
    return info.usage or NO_USAGE


def _ordered(rows: list[Process], field: str) -> list[Process]:
    """The rows in ``field``'s order, largest first where it is a size.

    Args:
        rows (list[Process]): the processes.
        field (str): the field.
    """
    keys = {
        "PID": lambda info: info.shown_pid,
        "USER": lambda info: info.session_id,
        "VIRT": lambda info: _usage_of(info).vsz,
        "RES": lambda info: _usage_of(info).rss,
        "%CPU": lambda info: _usage_of(info).cpu_percent,
        "%MEM": lambda info: _usage_of(info).memory_percent,
        "TIME+": lambda info: _usage_of(info).cpu_seconds,
        "COMMAND": lambda info: info.command,
    }
    ordered = sorted(rows, key=lambda info: info.shown_pid)
    return sorted(
        ordered,
        key=keys[field],
        reverse=constants.TOP_SORT_FIELDS[field],
    )


def _command_of(info: Process, full: bool) -> str:
    """What ``COMMAND`` shows.

    Args:
        info (Process): the process.
        full (bool): the whole command line.
    """
    if full:
        return info.command
    head = info.command.split()[0] if info.command.split() else ""
    return head.rsplit("/", 1)[-1]


def _table(
    rows: list[Process],
    options: TopOptions,
    several: bool,
    owner: str | None,
) -> list[str]:
    """The process table, with a ``MACHINE`` column before ``COMMAND``
    for several machines.

    Args:
        rows (list[Process]): the processes.
        options (TopOptions): how to print.
        several (bool): say which machine each row is about.
        owner (str | None): the session's profile.
    """
    machines = [info.shown_machine for info in rows]
    width = max([len(MACHINE_HEADER), *map(len, machines)])
    place = f"{MACHINE_HEADER:<{width}} " if several else ""
    lines = [
        f"{'PID':>5} {'USER':<8} {'PR':>3} {'NI':>3} {'VIRT':>7} {'RES':>6} "
        f"{'SHR':>6} S {'%CPU':>5} {'%MEM':>5} {'TIME+':>9} {place}COMMAND"
    ]
    for info in _ordered(rows, options.sort):
        usage = info.usage or NO_USAGE
        state = info.shown_state or STATES[info.state]
        place = f"{info.shown_machine:<{width}} " if several else ""
        line = (
            f"{info.shown_pid:>5} {owner or UNKNOWN_NAME:<8} {20:>3} {0:>3} "
            f"{_kib(usage.vsz, 7):>7} {_kib(usage.rss, 6):>6} {0:>6} {state} "
            f"{usage.cpu_percent:>5.1f} {usage.memory_percent:>5.1f} "
            f"{_cpu_clock(usage.cpu_seconds):>9} {place}"
        )
        command = _command_of(info, options.full)
        room = options.width - len(line)
        if room > 1 and len(command) > room:
            command = f"{command[: room - 1]}+"
        lines.append(line + command)
    return lines


async def _frame_of(
    job_table: JobTable,
    session: SessionState | None,
    scope: MachineScope,
    options: TopOptions,
) -> tuple[str, str]:
    """One frame of output, and what the machines that did not answer
    said.

    Args:
        job_table (JobTable): the workspace's jobs.
        session (SessionState | None): the shell session.
        scope (MachineScope): the machines.
        options (TopOptions): how to print.
    """
    processes = job_table.processes
    machines, errors = await read_machines(processes, scope, "top", cpu=True)
    await processes.scan()
    caller = current_caller().process
    own = caller.record.pid if caller is not None else None
    rows = [
        info
        for info in processes.visible(session_of(session), grants_of(session))
        if not info.stages
        and info.pid != own
        and (
            info.shown_machine in scope.ids
            or info.shown_machine == WORKSPACE_MACHINE
        )
        and (not options.pids or info.shown_pid in options.pids)
    ]
    lines: list[str] = []
    for row in machines:
        for line in _block(row, options.scale):
            lines.append(
                with_machine(line, row.machine) if scope.several else line
            )
    lines.append("")
    profile = session.profile if session is not None else None
    lines += _table(rows, options, scope.several, profile)
    if options.narrowed and not scope.several:
        lines = [line[: options.width] for line in lines]
    return "".join(f"{line}\n" for line in lines), errors


async def _frames_of(
    first: str,
    job_table: JobTable,
    session: SessionState | None,
    scope: MachineScope,
    options: TopOptions,
) -> AsyncIterator[bytes]:
    """The first frame, then one every ``delay`` until ``iterations``.

    Args:
        first (str): the first frame, already read.
        job_table (JobTable): the workspace's jobs.
        session (SessionState | None): the shell session.
        scope (MachineScope): the machines.
        options (TopOptions): how to print.
    """
    yield encode_text(first)
    done = 1
    while options.iterations is None or done < options.iterations:
        await asyncio.sleep(options.delay)
        text, _ = await _frame_of(job_table, session, scope, options)
        yield encode_text(f"\n{text}")
        done += 1


def _read_options(
    flags: dict[str, str | bool],
) -> tuple[TopOptions | None, str]:
    """How the options say to print, or why they cannot.

    Args:
        flags (dict[str, str | bool]): every option given.
    """
    iterations: int | None = None
    if isinstance(flags.get("n"), str):
        text = str(flags["n"])
        if not (text.isascii() and text.isdigit()) or int(text) < 1:
            return None, f"top: bad iterations argument '{text}'\n"
        iterations = int(text)
    delay = constants.TOP_DELAY_SECONDS
    if isinstance(flags.get("d"), str):
        text = str(flags["d"])
        try:
            delay = float(text)
        except ValueError:
            return None, f"top: bad delay interval '{text}'\n"
        if delay < 0:
            return None, "top: -d requires positive argument\n"
    width = constants.TOP_WIDTH
    if isinstance(flags.get("w"), str):
        text = str(flags["w"])
        if not (text.isascii() and text.isdigit()):
            return None, f"top: bad width arg '{text}'\n"
        width = int(text)
    scale = "m"
    if isinstance(flags.get("E"), str):
        scale = str(flags["E"])
        if scale not in constants.TOP_SCALES:
            return None, f"top: bad memory scaling arg '{scale}'\n"
    sort = "%CPU"
    if isinstance(flags.get("o"), str):
        sort = str(flags["o"]).lstrip("+-")
        if sort not in constants.TOP_SORT_FIELDS:
            return None, f"top: unrecognized field name '{sort}'\n"
    pids: set[int] = set()
    if isinstance(flags.get("p"), str):
        for word in str(flags["p"]).split(","):
            if not (word.isascii() and word.isdigit()):
                return None, f"top: bad pid '{word}'\n"
            pids.add(int(word))
    return (
        TopOptions(
            iterations,
            delay,
            flags.get("c") is True,
            width,
            scale,
            sort,
            frozenset(pids),
            isinstance(flags.get("w"), str),
        ),
        "",
    )


async def handle_top(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Show how busy the machines a line can use are, in ``top``'s
    batch layout: the processors are read twice a moment apart, as one
    read says nothing of now, and ``machine_scope`` chooses the machines;
    several print their summary lines one after another, each ending in
    the machine, and a ``MACHINE`` column in the process table, which
    lists the processes ``ps`` does. Without ``-b`` it refuses as ``top``
    does without a terminal.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``top`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    parse = parse_shell_options(SHELL_SPECS["top"], parts[1:])
    refusal = option_refusal("top", parse, page=False)
    if refusal:
        return job_result(cmd_str, refusal, 1)
    if parse.flags.get("h") is True:
        return (
            encode_text(usage_page("top")),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if parse.operands:
        return job_result(
            cmd_str, f"top: unknown option '{parse.operands[0]}'\n", 1
        )
    options, said = _read_options(parse.flags)
    if options is None:
        return job_result(cmd_str, said, 1)
    if parse.flags.get("b") is not True:
        return job_result(cmd_str, "top: failed tty get\n", 1)
    name = parse.flags.get("machine")
    named = name if isinstance(name, str) else None
    scope = machine_scope(job_table.processes, named)
    if scope is None:
        return job_result(cmd_str, f"top: {named}: no such machine\n", 1)
    text, errors = await _frame_of(job_table, session, scope, options)
    code = 1 if errors else 0
    err = encode_text(errors) or None
    out: ByteSource = (
        encode_text(text)
        if options.iterations == 1
        else _frames_of(text, job_table, session, scope, options)
    )
    return (
        out,
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
