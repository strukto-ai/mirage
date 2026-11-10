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

from mirage.commands.spec.shell import SHELL_SPECS
from mirage.commands.spec.standard import version_line
from mirage.execution.job import JobTable
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.types import Process
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.rs.errors import RegexError
from mirage.rs.regex import posix_regex
from mirage.shell.bytes import encode_text
from mirage.shell.constants import SIGRTMAX, SIGTERM
from mirage.shell.signals import signal_number
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.jobspec import (
    grants_of,
    job_result,
    scanning_while,
    session_of,
)
from mirage.workspace.executor.builtins.kill.kill import signal_one
from mirage.workspace.executor.builtins.machine_view import (
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

_SIGNAL_NAMES = (
    "HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM "
    "STKFLT\n"
    "CHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR "
    "SYS\n"
)

# Capital letters that are options, not the start of a signal's name.
_CAPITAL_OPTIONS = frozenset("IVZ")


def _leading_signal(words: list[str]) -> tuple[int | None, str, list[str]]:
    """A first word that names a signal, and the words after it.

    Args:
        words (list[str]): the words after ``killall``.

    Returns:
        tuple[int | None, str, list[str]]: its number, None for no
        signal or one it does not know; the name it does not know, if
        any; the remaining words.
    """
    if not words or not words[0].startswith("-") or len(words[0]) < 2:
        return None, "", words
    body = words[0][1:]
    if body.isascii() and body.isdigit():
        return int(body), "", words[1:]
    if not body[0].isupper() or body in _CAPITAL_OPTIONS:
        return None, "", words
    number = signal_number(body)
    if number is None:
        return None, body.removeprefix("SIG"), words[1:]
    return number, "", words[1:]


def _picks_of(
    name: str,
    rows: list[Process],
    exact: bool,
    ignore_case: bool,
    regexp: bool,
) -> list[Process] | None:
    """The processes a name selects; None for a pattern that does not
    compile.

    Args:
        name (str): the name or pattern.
        rows (list[Process]): the processes to pick from.
        exact (bool): ``-e``, the whole name, however long.
        ignore_case (bool): ``-I``.
        regexp (bool): ``-r``.
    """
    if regexp:
        try:
            matcher = posix_regex(name, extended=True, ignore_case=ignore_case)
        except RegexError:
            return None
        return [
            info
            for info in rows
            if matcher.search_blocking(process_name(info)) is not None
        ]

    def folded(text: str) -> str:
        return text.casefold() if ignore_case else text

    wanted = folded(name)

    def full_name(info: Process) -> str:
        words = info.command.split()
        return folded(words[0].rsplit("/", 1)[-1]) if words else ""

    if exact:
        return [info for info in rows if full_name(info) == wanted]
    return [
        info
        for info in rows
        if full_name(info)[:NAME_WIDTH] == wanted[:NAME_WIDTH]
    ]


async def handle_killall(
    job_table: JobTable,
    parts: list[str],
    session: SessionState | None = None,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Signal every process with one of the given names among those
    ``ps`` shows, on every machine they run on, the way ``kill`` does.
    Answers 0 only when each name found a process. A first word
    ``-NAME`` or ``-NUMBER`` is the signal, as ``-s`` is.

    Args:
        job_table (JobTable): the workspace's jobs.
        parts (list[str]): the command words, ``killall`` first.
        session (SessionState | None): the shell session.
        view (SessionView | None): the gated session view.
    """
    cmd_str = " ".join(parts)
    leading, unknown, words = _leading_signal(parts[1:])
    parse = permuted_options(SHELL_SPECS["killall"], words)
    flags = parse.flags
    if flags.get("l") is True:
        return (
            encode_text(_SIGNAL_NAMES),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if flags.get("V") is True:
        return (
            version_line("killall"),
            IOResult(),
            ExecutionNode(command=cmd_str, exit_code=0),
        )
    if flags.get("help") is True:
        return job_result(cmd_str, usage_page("killall"), 0)
    refusal = option_refusal("killall", parse, page=False)
    if refusal or (not parse.operands and not unknown):
        return job_result(cmd_str, usage_page("killall"), 1)
    signal = leading if leading is not None else SIGTERM
    named = flags.get("s")
    if isinstance(named, str):
        number = (
            int(named)
            if named.isascii() and named.isdigit()
            else signal_number(named)
        )
        if number is None:
            unknown = named.removeprefix("SIG")
        else:
            signal = number
    if unknown:
        return job_result(
            cmd_str,
            f"{unknown}: unknown signal; killall -l lists signals.\n",
            1,
        )
    machine = flags.get("machine")
    picked_machine = machine if isinstance(machine, str) else None
    processes = job_table.processes
    scope = process_scope(processes, picked_machine)
    if scope is None:
        return job_result(
            cmd_str, f"killall: {picked_machine}: no such machine\n", 1
        )
    rows = await running(job_table, session, scope)
    sid = session_of(session)
    jobs = job_table.list_jobs(sid)
    quiet = flags.get("q") is True
    errors: list[str] = []
    missed = False
    gone: list[ProcessHandle] = []
    for name in parse.operands:
        picks = _picks_of(
            name,
            rows,
            flags.get("e") is True,
            flags.get("I") is True,
            flags.get("r") is True,
        )
        if picks is None:
            return job_result(
                cmd_str, f"killall: Bad regular expression: {name}\n", 1
            )
        killed = 0
        for info in picks:
            if signal > SIGRTMAX:
                if not quiet:
                    errors.append(
                        f"{process_name(info)}({info.shown_pid}): "
                        "Invalid argument\n"
                    )
                continue
            try:
                handle = processes.target(info.pid, sid, grants_of(session))
                found = await signal_one(
                    job_table, session, jobs, info.pid, signal
                )
            except PermissionError:
                if not quiet:
                    errors.append(
                        f"{process_name(info)}({info.shown_pid}): "
                        "Operation not permitted\n"
                    )
                continue
            if found:
                killed += 1
                if handle is not None:
                    gone.append(handle)
                if flags.get("v") is True:
                    errors.append(
                        f"Killed {process_name(info)}({info.shown_pid}) "
                        f"with signal {signal}\n"
                    )
        if not killed:
            missed = True
            if not quiet:
                errors.append(f"{name}: no process found\n")
    if flags.get("w") is True and gone:
        await scanning_while(
            processes, asyncio.wait([handle.task for handle in gone])
        )
    code = 1 if missed else 0
    err = encode_text("".join(errors)) or None
    return (
        b"",
        IOResult(exit_code=code, stderr=err),
        ExecutionNode(command=cmd_str, exit_code=code, stderr=err or b""),
    )
