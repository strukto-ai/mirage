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

from datetime import datetime

from mirage.commands.builtin.utils.identity import UNKNOWN_NAME
from mirage.commands.builtin.utils.strftime import gnu_strftime
from mirage.execution.job import JobTable
from mirage.execution.process.constants import FIRST_PID
from mirage.execution.process.types import Process
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.utils.clock import system_now
from mirage.utils.timezone import zone_from_env
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import MAX_PID_OPERAND
from mirage.workspace.executor.builtins.jobspec import (
    job_result,
    process_view,
    session_of,
)
from mirage.workspace.executor.builtins.ps import constants
from mirage.workspace.executor.builtins.ps.types import PsContext, PsOptions
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


def _ps_pids(value: str, option: str) -> set[int]:
    """One ``-p`` list, refused in procps's words.

    Args:
        value (str): the list, comma or blank separated.
        option (str): the option as typed, for the missing-list error.
    """
    tokens = value.replace(",", " ").split()
    if not tokens:
        raise ValueError(f"list of process IDs must follow {option}")
    pids: set[int] = set()
    for token in tokens:
        body = token[1:] if token[:1] in "+-" else token
        if not body.isascii() or not body.isdigit():
            raise ValueError("process ID list syntax error")
        number = int(token)
        if number <= 0 or number > MAX_PID_OPERAND:
            raise ValueError("process ID out of range")
        pids.add(number)
    return pids


def _ps_columns(value: str, option: str) -> list[tuple[str, str]]:
    """One ``-o`` list: ``key`` or ``key=header``, refused in procps's words.

    Args:
        value (str): the format list, comma or blank separated.
        option (str): the option as typed, for the missing-list error.
    """
    if not value.strip():
        raise ValueError(f"format specification must follow {option}")
    columns: list[tuple[str, str]] = []
    for item in value.split(","):
        if not item.strip():
            raise ValueError("improper format list")
        for token in item.split():
            key, equal, header = token.partition("=")
            if key not in constants.COLUMNS:
                raise ValueError(
                    f'unknown user-defined format specifier "{key}"'
                )
            columns.append(
                (key, header if equal else constants.COLUMNS[key][0])
            )
    return columns


def _parse_ps(words: list[str]) -> PsOptions:
    """Parse the procps selection and output options a runner answers.

    SysV letters after one dash, BSD letters with none, and the
    ``--pid``/``--format``/``--forest`` long forms; ``-p`` and ``-o``
    repeat and accumulate. BSD ``f`` and ``--forest`` draw the forest;
    ``-f`` and BSD ``u``/``w`` pick a layout the processes do not have,
    so they leave the plain one.

    Args:
        words (list[str]): arguments after ps.
    """
    pids: set[int] = set()
    columns: list[tuple[str, str]] = []
    select_all = False
    forest = False
    at = 0
    while at < len(words):
        word = words[at]
        at += 1
        if word == "--forest":
            forest = True
            continue
        if word.startswith("--"):
            option, equal, attached = word.partition("=")
            if option not in ("--pid", "--format"):
                raise ValueError("unknown gnu long option")
            if not equal:
                attached = words[at] if at < len(words) else ""
                at += 1
            if option == "--pid":
                pids |= _ps_pids(attached, option)
            else:
                columns += _ps_columns(attached, option)
            continue
        if not word.startswith("-"):
            if not word or any(letter not in "auxwf" for letter in word):
                raise ValueError("unsupported option (BSD syntax)")
            select_all = select_all or any(letter in "ax" for letter in word)
            forest = forest or "f" in word
            continue
        letters = word[1:]
        while letters:
            flag, letters = letters[0], letters[1:]
            if flag in constants.ALL:
                select_all = True
                continue
            if flag == "f":
                continue
            if flag not in "po":
                raise ValueError("unsupported SysV option")
            value, letters = letters, ""
            if not value:
                value = words[at] if at < len(words) else ""
                at += 1
            if flag == "p":
                pids |= _ps_pids(value, "-p")
            else:
                columns += _ps_columns(value, "-o")
    return PsOptions(frozenset(pids), select_all, tuple(columns), forest)


def _ps_row(keys: list[str], cells: list[str]) -> str:
    """One row in procps's layout: each column padded but the last.

    Args:
        keys (list[str]): the column keys, in output order.
        cells (list[str]): the rendered cells, one per key.
    """
    out: list[str] = []
    for at, (key, cell) in enumerate(zip(keys, cells)):
        _, width, right, _ = constants.COLUMNS[key]
        if right:
            out.append(cell.rjust(width))
        elif at == len(keys) - 1:
            out.append(cell)
        else:
            out.append(cell.ljust(width))
    return " ".join(out)


def _elapsed(seconds: int) -> str:
    """procps's etime: ``[[DD-]hh:]mm:ss``.

    Args:
        seconds (int): time since the runner started.
    """
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    if days:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _started(fact: str, info: Process, ctx: PsContext) -> str:
    """One start-time column, lstart, start, stime or bsdstart, in the
    layouts measured from procps-ng 4.0.4's ``ps -o`` output: a day-old
    start prints its date, a recent one its clock.

    Args:
        fact (str): lstart, start, stime or bsdstart.
        info (Process): the runner.
        ctx (PsContext): the line's shared facts.
    """
    start = datetime.fromtimestamp(info.started_at, ctx.zone)
    if fact == "lstart":
        return gnu_strftime(start, "%a %b %e %H:%M:%S %Y")
    old = ctx.now - info.started_at > 86400
    if fact == "start":
        return gnu_strftime(start, "  %b %d" if old else "%H:%M:%S")
    if fact == "bsdstart":
        return gnu_strftime(start, "%b %e" if old else "%H:%M")
    now = datetime.fromtimestamp(ctx.now, ctx.zone)
    if now.year != start.year:
        return gnu_strftime(start, "%Y")
    if now.timetuple().tm_yday != start.timetuple().tm_yday:
        return gnu_strftime(start, "%b%d")
    return gnu_strftime(start, "%H:%M")


def _ps_cell(key: str, info: Process, ctx: PsContext, branch: str) -> str:
    """One -o cell for a process.

    The owner columns print the workspace user and the session's
    profile, names in the id columns too, as ``id`` does, and ``-``
    where nobody claimed one or the runner is another session's, whose
    profile this one cannot name. A runner of the calling session belongs
    to the session ``$$`` leads; another session's to its own group. The
    machine columns name the machine a program runs on and its pid
    there, ``-`` for a process that is Mirage's own.

    Args:
        key (str): the column key.
        info (Process): the runner.
        ctx (PsContext): the line's shared facts.
        branch (str): what a forest draws before its command.
    """
    fact = constants.COLUMNS[key][3]
    if fact in constants.FIXED:
        return constants.FIXED[fact]
    if fact == "machine":
        program = info.runtime is not None or info.machine_pid is not None
        return str(info.machine) if program else "-"
    if fact == "mpid":
        found = info.machine_pid
        return str(found.pid) if found is not None else "-"
    session = (
        ctx.shell_pid
        if info.session_id == ctx.session_id and ctx.shell_pid is not None
        else info.group or info.pid
    )
    if fact == "pid":
        return str(info.pid)
    if fact == "ppid":
        return str(info.parent) if info.parent else "0"
    if fact == "pgid":
        return str(info.group or info.pid)
    if fact == "sid":
        return str(session)
    if fact in ("stat", "state"):
        state = constants.STATES[info.state]
        return state + ("s" if fact == "stat" and info.pid == session else "")
    if fact == "comm":
        head = info.command.split()[0] if info.command.split() else ""
        return branch + head.rsplit("/", 1)[-1][:15]
    if fact in ("user", "group"):
        own = info.session_id == ctx.session_id
        return (ctx.group if own else None) or UNKNOWN_NAME
    elapsed = max(0, int(ctx.now - info.started_at))
    if fact == "etime":
        return _elapsed(elapsed)
    if fact == "etimes":
        return str(elapsed)
    if fact in ("lstart", "start", "stime", "bsdstart"):
        return _started(fact, info, ctx)
    return branch + info.command


def _forest(rows: list[Process]) -> list[tuple[Process, str]]:
    """The rows as procps draws a forest: each process under its
    parent, siblings by pid, a process whose parent is not listed a
    root; each with what goes before its command.

    Args:
        rows (list[Process]): the selected processes.
    """
    listed = {info.pid for info in rows}
    children: dict[int | None, list[Process]] = {}
    for info in sorted(rows, key=lambda info: info.pid):
        above = info.parent if info.parent in listed else None
        children.setdefault(above, []).append(info)
    drawn: list[tuple[Process, str]] = []

    def walk(parent: int | None, trail: str) -> None:
        kids = children.get(parent, [])
        for at, kid in enumerate(kids):
            later = at < len(kids) - 1
            drawn.append(
                (kid, "" if parent is None else trail + constants.BRANCH)
            )
            below = (
                ""
                if parent is None
                else trail + (constants.BAR if later else constants.GAP)
            )
            walk(kid.pid, below)

    walk(None, "")
    return drawn


async def handle_ps(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """List processes with procps's selection and ``-o`` columns.

    The machines are scanned first, so what a program started there
    shows as processes of its own. Without ``-o`` the columns are
    ``PID MACHINE MPID CMD`` (``constants.PLAIN``); ``-o`` lays out
    procps-ng 4.0.4's columns, every key a process can answer
    (``constants.COLUMNS``), ``machine`` and ``mpid`` among them; a
    header row prints unless every header is empty. BSD ``f`` and
    ``--forest`` draw each command under its parent's. A ``-p`` number
    under ``FIRST_PID`` is a machine pid. Selecting nothing (``-p`` of
    an absent PID) exits 1, as procps does, and an option error is
    procps's message and usage. A process has no CPU, RSS or TTY
    accounting, and ps never broadens the profile's view.

    The daemon running the line holds the workspace's lease, so its
    processes are every one the workspace has.

    Args:
        job_table (JobTable): the workspace's job table.
        parts (list[str]): the command words, `ps` first.
        session (SessionState | None): the shell session, if any.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    try:
        options = _parse_ps(parts[1:])
    except ValueError as exc:
        return job_result(cmd_str, f"error: {exc}\n{constants.USAGE}", 1)
    sid = session_of(session)
    processes = process_view(job_table, session)
    await processes.scan()
    every = options.all or not options.pids
    rows = [
        info
        for info in processes.list()
        if every
        or info.pid in options.pids
        or (
            info.machine_pid is not None
            and info.machine_pid.exited is None
            and info.machine_pid.pid < FIRST_PID
            and info.machine_pid.pid in options.pids
        )
    ]
    columns = options.columns or constants.PLAIN
    keys = [key for key, _ in columns]
    ctx = PsContext(
        now=system_now(),
        zone=zone_from_env(session.env) if session is not None else None,
        group=session.profile if session is not None else None,
        session_id=sid,
        shell_pid=session.shell_pid if session is not None else None,
    )
    drawn = (
        _forest(rows)
        if options.forest
        else [(info, "") for info in sorted(rows, key=lambda r: r.pid)]
    )
    lines = [
        _ps_row(keys, [_ps_cell(key, info, ctx, branch) for key in keys])
        for info, branch in drawn
    ]
    if any(header for _, header in columns):
        lines.insert(0, _ps_row(keys, [h for _, h in columns]))
    code = 0 if rows else 1
    out = encode_text("\n".join(lines) + "\n") if lines else b""
    return (
        out,
        IOResult(exit_code=code),
        ExecutionNode(command=cmd_str, exit_code=code),
    )
