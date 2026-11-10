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

from dataclasses import dataclass

from mirage.commands.builtin.grep_pattern import compile_pattern
from mirage.commands.errors import UsageError
from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.standard import version_line
from mirage.context import current_caller
from mirage.execution.job import JobTable
from mirage.execution.process.types import Process
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.rs.regex import LineRegex
from mirage.shell.bytes import encode_text
from mirage.shell.constants import SIGTERM
from mirage.shell.signals import signal_number
from mirage.utils.clock import system_now
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import (
    grants_of,
    job_result,
    session_of,
)
from mirage.workspace.executor.builtins.kill.kill import signal_one
from mirage.workspace.executor.builtins.machine_view import (
    MachineScope,
    option_refusal,
    permuted_options,
    process_scope,
    usage_page,
)
from mirage.workspace.executor.builtins.pgrep.shared import (
    NAME_WIDTH,
    process_name,
    running,
)
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

# What a search answers: found, found nothing, or could not search.
_FOUND = 0
_NOT_FOUND = 1
_REFUSED = 2

# Every option a search's value lists number.
NUMBERED = {"P": "parents", "g": "groups", "s": "sessions"}

Flags = dict[str, str | bool]


@dataclass(frozen=True, slots=True)
class Searched:
    """How a search went.

    Args:
        picked (list[Process]): the processes it picked.
        scope (MachineScope | None): the machines looked at; None when
            it could not search.
        flags (Flags): the options.
        said (str): what it says on stderr.
        status (int): for one that could not search, its status.
    """

    picked: list[Process]
    scope: MachineScope | None
    flags: Flags
    said: str
    status: int


@dataclass(frozen=True, slots=True)
class Search:
    """What a search selects.

    Args:
        matcher (LineRegex | None): the pattern; None for every name.
        full (bool): ``-f``, match the whole command line.
        inverse (bool): ``-v``.
        newest (bool): ``-n``.
        oldest (bool): ``-o``.
        older (float | None): ``-O``'s seconds.
        parents (frozenset[int]): ``-P``'s pids.
        groups (frozenset[int]): ``-g``'s groups.
        sessions (frozenset[int]): ``-s``'s sessions.
        states (str): ``-r``'s state letters.
    """

    matcher: LineRegex | None
    full: bool
    inverse: bool
    newest: bool
    oldest: bool
    older: float | None
    parents: frozenset[int]
    groups: frozenset[int]
    sessions: frozenset[int]
    states: str


def _refused(flags: Flags, said: str) -> Searched:
    """A search that could not run.

    Args:
        flags (Flags): the options.
        said (str): why.
    """
    return Searched([], None, flags, said, _REFUSED)


def _try_again(name: str) -> str:
    """The hint a search follows a usage error with.

    Args:
        name (str): the command.
    """
    return f"Try `{name} --help' for more information.\n"


def _numbers(name: str, text: str) -> tuple[frozenset[int], str]:
    """A comma-separated list of numbers, or why it is not one.

    Args:
        name (str): the command.
        text (str): the list.
    """
    numbers: set[int] = set()
    for word in text.split(","):
        if not (word.isascii() and word.isdigit()):
            return frozenset(), f"{name}: not a number: {word}\n"
        numbers.add(int(word))
    return frozenset(numbers), ""


def _matcher_of(
    name: str, pattern: str | None, ignore_case: bool, exact: bool
) -> tuple[LineRegex | None, str]:
    """A search's pattern, compiled as an extended regular expression,
    or why it does not compile.

    Args:
        name (str): the command.
        pattern (str | None): the pattern, None for none.
        ignore_case (bool): ``-i``.
        exact (bool): ``-x``, the whole name must match.
    """
    if pattern is None:
        return None, ""
    try:
        return (
            compile_pattern(
                pattern, ignore_case=ignore_case, line_regexp=exact
            ),
            "",
        )
    except UsageError as exc:
        reason = str(exc).removeprefix("grep: ")
        return None, f"{name}: regex error: {reason}\n"


def _selected(
    rows: list[Process],
    search: Search,
    shown: dict[int, int],
    leaders: dict[int, int],
    now: float,
) -> list[Process]:
    """The processes a search picks, by pid.

    Args:
        rows (list[Process]): the processes to pick from.
        search (Search): what it selects.
        shown (dict[int, int]): each visible process's pid as the agent
            knows it.
        leaders (dict[int, int]): each row's session leader, as ``ps``
            reads its ``sid``.
        now (float): the moment it runs, epoch seconds.
    """

    def wanted(info: Process) -> bool:
        haystack = info.command if search.full else process_name(info)
        parent = shown.get(info.parent or 0, 0)
        group = shown.get(info.group or info.pid, info.group or info.pid)
        session = shown.get(leaders[info.pid], leaders[info.pid])
        return (
            (
                search.matcher is None
                or search.matcher.matches_blocking(haystack)
            )
            and (not search.parents or parent in search.parents)
            and (not search.groups or group in search.groups)
            and (not search.sessions or session in search.sessions)
            and (
                not search.states
                or (info.shown_state or "S")[0] in search.states
            )
            and (search.older is None or now - info.started_at >= search.older)
        )

    picked = sorted(
        (info for info in rows if wanted(info) != search.inverse),
        key=lambda info: info.shown_pid,
    )
    if picked and search.newest:
        return [max(picked, key=lambda info: (info.started_at, info.pid))]
    if picked and search.oldest:
        return [min(picked, key=lambda info: (info.started_at, info.pid))]
    return picked


async def _search_for(
    name: str,
    words: list[str],
    job_table: JobTable,
    session: SessionState | None,
) -> Searched:
    """Read a search's options and run it.

    Args:
        name (str): the command.
        words (list[str]): its words, its name excluded.
        job_table (JobTable): the workspace's jobs.
        session (SessionState | None): the shell session.

    Returns:
        Searched: how it went.
    """
    parse = permuted_options(SHELL_SPECS[name], words)
    refusal = option_refusal(name, parse)
    if refusal:
        return _refused(parse.flags, refusal)
    flags = parse.flags
    if flags.get("n") is True and flags.get("o") is True:
        return _refused(flags, f"\n{usage_page(name)}")
    if len(parse.operands) > 1:
        said = f"{name}: only one pattern can be provided\n{_try_again(name)}"
        return _refused(flags, said)
    numbered: dict[str, frozenset[int]] = {
        field: frozenset() for field in NUMBERED.values()
    }
    for letter, field in NUMBERED.items():
        if isinstance(flags.get(letter), str):
            numbered[field], said = _numbers(name, str(flags[letter]))
            if said:
                return _refused(flags, said)
    older: float | None = None
    if isinstance(flags.get("O"), str):
        text = str(flags["O"])
        if not (text.isascii() and text.isdigit()):
            return _refused(flags, f"{name}: not a number: {text}\n")
        older = float(text)
    states = flags.get("r")
    pattern = parse.operands[0] if parse.operands else None
    criteria = (
        pattern is not None
        or older is not None
        or isinstance(states, str)
        or any(numbered.values())
    )
    if not criteria:
        said = f"{name}: no matching criteria specified\n{_try_again(name)}"
        return _refused(flags, said)
    matcher, said = _matcher_of(
        name, pattern, flags.get("i") is True, flags.get("x") is True
    )
    if said:
        return _refused(flags, said)
    machine = flags.get("machine")
    named = machine if isinstance(machine, str) else None
    processes = job_table.processes
    scope = process_scope(processes, named)
    if scope is None:
        return _refused(flags, f"{name}: {named}: no such machine\n")
    full = flags.get("f") is True
    said = (
        f"{name}: pattern that searches for process name longer than "
        f"{NAME_WIDTH} characters will result in zero matches\n"
        f"Try `{name} -f' option to match against the complete command "
        "line.\n"
        if pattern is not None and not full and len(pattern) > NAME_WIDTH
        else ""
    )
    rows = await running(job_table, session, scope)
    sid = session_of(session)
    seen = processes.visible(sid, grants_of(session))
    shown = {info.pid: info.shown_pid for info in seen}
    shell = session.shell_pid if session is not None else None
    leaders = {
        info.pid: shell
        if info.session_id == sid and shell is not None
        else info.group or info.pid
        for info in rows
    }
    caller = current_caller().process
    group = (
        caller.record.group or caller.record.pid
        if caller is not None
        else None
    )
    search = Search(
        matcher,
        full,
        flags.get("v") is True,
        flags.get("n") is True,
        flags.get("o") is True,
        older,
        numbered["parents"],
        _own_zero(
            numbered["groups"],
            shown.get(group, group) if group is not None else None,
        ),
        _own_zero(
            numbered["sessions"],
            shown.get(shell, shell) if shell is not None else None,
        ),
        states if isinstance(states, str) else "",
    )
    picked = _selected(rows, search, shown, leaders, system_now())
    return Searched(picked, scope, flags, said, 0)


def _own_zero(listed: frozenset[int], own: int | None) -> frozenset[int]:
    """A ``-g`` or ``-s`` list with 0 read as the searcher's own group or
    session, as procps reads it.

    Args:
        listed (frozenset[int]): the numbers given.
        own (int | None): the searcher's; None when it has none.
    """
    if 0 not in listed or own is None:
        return listed
    return frozenset(own if number == 0 else number for number in listed)


def _listed(picked: list[Process], flags: Flags, scope: MachineScope) -> str:
    """What ``pgrep`` prints.

    Args:
        picked (list[Process]): the processes.
        flags (Flags): the options.
        scope (MachineScope): the machines looked at.
    """
    if flags.get("c") is True:
        return f"{len(picked)}\n"
    delimiter = flags.get("d")

    def row(info: Process) -> str:
        pid = str(info.shown_pid)
        if flags.get("a") is True:
            return f"{pid} {info.command}"
        if flags.get("l") is True:
            return f"{pid} {process_name(info)}"
        return pid

    if isinstance(delimiter, str):
        joined = delimiter.join(row(info) for info in picked)
        return f"{joined}\n" if picked else ""
    return "".join(
        f"{row(info)}  {info.shown_machine}\n"
        if scope.several
        else f"{row(info)}\n"
        for info in picked
    )


async def handle_pgrep(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Find processes by name or command line among those ``ps`` shows,
    so the search neither sees Mirage's own wrappers on a machine nor
    misses another machine; with several machines each row ends in its
    machine, unless ``-c`` or ``-d`` asks for a bare answer. A workspace
    has one user, so ``-u`` and ``-U`` select every process.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``pgrep`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    early = _standard_answer("pgrep", parts[1:], cmd_str)
    if early is not None:
        return early
    found = await _search_for("pgrep", parts[1:], job_table, session)
    picked, scope, flags, said = (
        found.picked,
        found.scope,
        found.flags,
        found.said,
    )
    if scope is None:
        return job_result(cmd_str, said, found.status)
    code = _FOUND if picked else _NOT_FOUND
    err = encode_text(said) or None
    return (
        encode_text(_listed(picked, flags, scope)),
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )


def _standard_answer(
    name: str, words: list[str], cmd_str: str
) -> tuple[ByteSource | None, IOResult, ExecutionNode] | None:
    """A search's answer to ``--help`` or ``-V``, None for any other line.

    Args:
        name (str): the command.
        words (list[str]): its words, its name excluded.
        cmd_str (str): the command line.
    """
    flags = permuted_options(SHELL_SPECS[name], words).flags
    if flags.get("h") is True:
        out = encode_text(usage_page(name))
    elif flags.get("V") is True:
        out = version_line(name)
    else:
        return None
    return out, IOResult(), ExecutionNode(command=cmd_str, exit_code=0)


async def handle_pkill(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Signal the processes ``pgrep`` would find, the way ``kill`` does,
    on every machine they run on. A first word ``-NAME`` or ``-NUMBER``
    is the signal, as ``--signal`` is.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``pkill`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    words = parts[1:]
    early = _standard_answer("pkill", words, cmd_str)
    if early is not None:
        return early
    signal = SIGTERM
    if words and words[0].startswith("-") and len(words[0]) > 1:
        number = signal_number(words[0][1:])
        if number is not None:
            signal = number
            words = words[1:]
    searched = await _search_for("pkill", words, job_table, session)
    picked, scope, flags, said = (
        searched.picked,
        searched.scope,
        searched.flags,
        searched.said,
    )
    if scope is None:
        return job_result(cmd_str, said, searched.status)
    named = flags.get("signal")
    if isinstance(named, str):
        number = signal_number(named)
        if number is None:
            return job_result(
                cmd_str,
                f'pkill: Unknown signal "{named}".\n',
                _REFUSED,
            )
        signal = number
    out: list[str] = []
    errors: list[str] = [said] if said else []
    killed = 0
    jobs = job_table.list_jobs(session_of(session))
    for info in picked:
        try:
            found = await signal_one(
                job_table, session, jobs, info.pid, signal
            )
        except PermissionError:
            errors.append(
                f"pkill: killing pid {info.shown_pid} failed: "
                "Operation not permitted\n"
            )
            continue
        if found:
            killed += 1
            if flags.get("e") is True:
                out.append(
                    f"{process_name(info)} killed (pid {info.shown_pid})\n"
                )
    if flags.get("c") is True:
        out.append(f"{killed}\n")
    code = _FOUND if killed else _NOT_FOUND
    err = encode_text("".join(errors)) or None
    return (
        encode_text("".join(out)),
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
