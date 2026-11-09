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
import contextlib
import logging
import math
import re
from collections.abc import AsyncIterator, Callable
from typing import Any

from mirage.commands.builtin.utils.strtod import STRTOD, strtod_double
from mirage.commands.builtin.utils.strtol import INT_MAX, bounded_decimal
from mirage.commands.quote import quote_text
from mirage.commands.spec.help import render_help
from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.synopsis import SYNOPSES
from mirage.commands.spec.usage import (
    ambiguous_option_error,
    missing_value_error,
    unexpected_value_error,
    unknown_option_error,
    usage_hint,
)
from mirage.context import (
    reset_current_session,
    reset_program_invocation,
    set_current_evaluation,
    set_program_invocation,
)
from mirage.execution.process.config import ProcessPermissions
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.process.table import ProcessTable
from mirage.io import IOResult
from mirage.io.stream import (
    OutputStream,
    ensure_stream,
    materialize,
    yield_bytes,
)
from mirage.io.types import ByteSource, OutputState
from mirage.shell.bytes import encode_text
from mirage.shell.console import Channel, JobConsole
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.constants import (
    CONTINUE_SIGNALS,
    NOT_FOUND_STATUS,
    SHELL_IGNORED_SIGNALS,
    SIGCHLD,
    SIGCONT,
    SIGKILL,
    SIGNALS,
    SIGRTMAX,
    SIGRTMIN,
    SIGSTOP,
    STOP_SIGNALS,
    TIMEOUT_STATUS,
)
from mirage.shell.helpers import get_text
from mirage.shell.join import shell_join
from mirage.shell.signals import signal_report
from mirage.shell.types import TSNodeLike
from mirage.shell.voice import shell_voice
from mirage.types import PathSpec
from mirage.workspace.evaluation import EvaluationContext, child_context
from mirage.workspace.executor.builtins.timeout.constants import (
    FORK_FAILED,
    SELF_KILLING_SIGNALS,
    SIGNAL_ALIASES,
    TIMEOUT_NAMES,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.statement import (
    redirected_body,
    reported_command,
)
from mirage.workspace.lookup.lookup import execs
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

_UNIT_SECONDS = {"": 1.0, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}


def _usage_error(message: str) -> tuple[None, IOResult, ExecutionNode]:
    # GNU timeout reserves 125 for its own failures; 124 means the
    # command was killed at the deadline.
    return _refuse(
        encode_text(f"timeout: {message}\n{usage_hint('timeout')}\n")
    )


def _refuse(
    stderr: bytes, exit_code: int = 125
) -> tuple[None, IOResult, ExecutionNode]:
    return (
        None,
        IOResult(exit_code=exit_code, stderr=stderr),
        ExecutionNode(command="timeout", exit_code=exit_code),
    )


def timeout_missing(name: str) -> str:
    """GNU's report of a command timeout finds nothing to run for.

    Args:
        name (str): the command word.
    """
    return (
        f"timeout: failed to run command '{quote_text(name)}': "
        "No such file or directory\n"
    )


def duration_seconds(raw: str) -> float | None:
    """A timeout DURATION in seconds: a C float plus an optional s/m/h/d.

    GNU timeout 9.7 takes the longest C-locale floating-point number at
    the front of the word, leading whitespace, an exponent, a hex float
    and inf included; at most one suffix letter may follow, and a
    negative or NaN interval is refused.

    Args:
        raw (str): duration operand as typed.
    """
    match = STRTOD.match(raw)
    if match is None:
        return None
    suffix = raw[match.end() :]
    if suffix not in _UNIT_SECONDS:
        return None
    value = strtod_double(match)
    if not value >= 0:
        return None
    return value * _UNIT_SECONDS[suffix]


# The offset after RTMIN or RTMAX: C blanks, then an optional sign, then
# decimal digits and nothing more (`RTMIN 2`, `RTMAX-01`; not `RTMIN+ 2`).
_RT_OFFSET = re.compile(r"[ \t\n\v\f\r]*([+-]?)([0-9]+)")


def _decimal(digits: str) -> int | None:
    if not digits.isascii() or not digits.isdigit():
        return None
    return bounded_decimal(digits, INT_MAX + 1)


def _status_signal(value: int) -> int | None:
    """The signal a bare number names, as GNU timeout 9.7 reads one.

    0 to 64 name themselves; 128 to 192 are a ``$?`` of 128 plus the
    signal, and from 256 on only the low byte counts, which must then be
    0 to 64 (``265`` is KILL, ``384`` nothing).

    Args:
        value (int): the number.
    """
    if value <= SIGRTMAX:
        return value
    if value < 256:
        return value - 128 if 128 <= value <= 128 + SIGRTMAX else None
    low = value % 256
    return low if low <= SIGRTMAX else None


def _realtime(name: str) -> int | None:
    for base, start in (("RTMIN", SIGRTMIN), ("RTMAX", SIGRTMAX)):
        if not name.startswith(base):
            continue
        rest = name[len(base) :]
        if not rest:
            return start
        match = _RT_OFFSET.fullmatch(rest)
        offset = None if match is None else _decimal(match.group(2))
        if match is None or offset is None:
            return None
        value = start - offset if match.group(1) == "-" else start + offset
        return value if SIGRTMIN <= value <= SIGRTMAX else None
    return None


def parse_signal(operand: str) -> int | None:
    """The signal a ``-s`` value names, None if it names none.

    Measured on GNU timeout 9.7: a number (decimal digits only, no sign
    or blank) may carry a shell's 128 or 256 offset, as ``$?`` does; a
    name is read in any case, with or without ``SIG``, and ``SIG`` before
    digits takes only 0 to 64. ``RTMIN+n`` and ``RTMAX-n`` stay inside
    the realtime range.

    Args:
        operand (str): the -s value as typed.
    """
    if not operand.isascii():
        return None
    if operand.isdigit():
        value = _decimal(operand)
        return None if value is None else _status_signal(value)
    name = operand.upper()
    name = name[3:] if name.startswith("SIG") else name
    if name.isdigit():
        value = _decimal(name)
        return value if value is not None and value <= SIGRTMAX else None
    if name in SIGNAL_ALIASES:
        return SIGNAL_ALIASES[name]
    for number, known in SIGNALS.items():
        if known == name:
            return number
    return _realtime(name)


def signal_name(number: int) -> str:
    """A signal's name as ``timeout -v`` prints it, or its number.

    The realtime range is named from RTMIN up to its middle (RTMIN+15 is
    49) and from RTMAX above it (50 is RTMAX-14), as GNU 9.7 and bash do.

    Args:
        number (int): the signal number.
    """
    if number in TIMEOUT_NAMES:
        return TIMEOUT_NAMES[number]
    if number in SIGNALS:
        return SIGNALS[number]
    if not SIGRTMIN <= number <= SIGRTMAX:
        return str(number)
    if number == SIGRTMIN:
        return "RTMIN"
    if number == SIGRTMAX:
        return "RTMAX"
    if number - SIGRTMIN <= (SIGRTMAX - SIGRTMIN) // 2:
        return f"RTMIN+{number - SIGRTMIN}"
    return f"RTMAX-{SIGRTMAX - number}"


async def handle_timeout(
    execute_fn: Callable[..., Any],
    args: list[str],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    registry: MountRegistry | None = None,
    processes: ProcessTable | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run `timeout [OPTION] DURATION COMMAND [ARG...]` (GNU timeout).

    The inner line is built with shell_join so already-expanded words
    survive re-parsing as one token each (GNU timeout execs the command
    without a shell). The command reads timeout's stdin and runs as a
    process of its own, a child of the caller's, so the jobs it starts
    are its children. At the deadline the command gets -s's signal (TERM
    by default), and a process here is a task, so the signal's default
    action decides: one that terminates ends the run, and 124 reports
    it, or the status a shell would show with --preserve-status; one
    that is ignored (0, CHLD, CONT, URG, WINCH) lets the run carry on,
    and -k's KILL ends it later with 137; a stop halts it until that
    KILL. timeout signals its own process group unless --foreground, so
    the jobs the command started get the signal too, and it dies of what
    it cannot ignore (KILL, 32, 33), stops itself on STOP, and never
    wakes after CHLD; each ends as GNU's does. -v says each signal on
    stderr.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): options, duration operand, then the command.
        context (EvaluationContext): the caller's evaluation, which the
            command's process forks.
        stdin (ByteSource | None): what the command reads.
        registry (MountRegistry | None): where the command name is
            looked up; None runs every name.
        processes (ProcessTable | None): the workspace's processes, which
            the command joins; None starts a table of its own.
    """
    session = context.session
    parse = parse_shell_options(SHELL_SPECS["timeout"], args or [])
    signal = 15
    kill_after = 0.0
    for name, value in parse.given:
        if name == "help":
            text = encode_text(
                render_help(
                    "timeout",
                    SHELL_SPECS["timeout"],
                    synopsis=SYNOPSES["timeout"],
                )
            )
            return (
                yield_bytes(text),
                IOResult(),
                ExecutionNode(command="timeout", exit_code=0),
            )
        if name == "version":
            return (
                yield_bytes(version_line("timeout")),
                IOResult(),
                ExecutionNode(command="timeout", exit_code=0),
            )
        if name == "k" and isinstance(value, str):
            after = duration_seconds(value)
            if after is None:
                return _usage_error(
                    f"invalid time interval '{quote_text(value)}'"
                )
            kill_after = after if after < math.inf else 0.0
        if name == "s" and isinstance(value, str):
            number = parse_signal(value)
            if number is None:
                return _usage_error(f"'{quote_text(value)}': invalid signal")
            signal = number
    if parse.invalid is not None:
        stderr, code = (
            ambiguous_option_error("timeout", parse.invalid, parse.candidates)
            if parse.candidates
            else unknown_option_error("timeout", parse.invalid)
        )
        return _refuse(stderr, code)
    if parse.unexpected_value is not None:
        return _refuse(
            *unexpected_value_error("timeout", parse.unexpected_value)
        )
    if parse.needs_value is not None:
        return _refuse(*missing_value_error("timeout", parse.needs_value))
    if len(parse.operands) < 2:
        return _refuse(encode_text(f"{usage_hint('timeout')}\n"))
    raw = parse.operands[0]
    seconds = duration_seconds(raw)
    if seconds is None:
        return _usage_error(f"invalid time interval '{quote_text(raw)}'")

    command = parse.operands[1:]
    if registry is not None and not execs(command[0], session, registry):
        return _refuse(
            encode_text(timeout_missing(command[0])), NOT_FOUND_STATUS
        )
    return await _supervise(
        execute_fn,
        shell_join(command),
        context,
        stdin,
        seconds,
        signal,
        kill_after,
        parse.flags,
        command[0],
        processes if processes is not None else ProcessTable(),
    )


async def _supervise(
    execute_fn: Callable[..., Any],
    inner: str,
    context: EvaluationContext,
    stdin: ByteSource | None,
    seconds: float,
    signal: int,
    kill_after: float,
    flags: dict[str, str | bool],
    name: str,
    processes: ProcessTable,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Start the inner line under the deadline and hand back its stdout
    as it writes it, as GNU's command writes to timeout's own stdout; the
    status, stderr and node settle once that stream ends, as GNU's
    answer does.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        inner (str): the joined command line.
        context (EvaluationContext): the caller's evaluation.
        stdin (ByteSource | None): what the command reads.
        seconds (float): the deadline; 0 (or inf) is none.
        signal (int): the signal sent at the deadline.
        kill_after (float): -k, how long until KILL follows; 0 is never.
        flags (dict[str, str | bool]): the parsed options.
        name (str): the command word, which -v names.
        processes (ProcessTable): where the command's process starts.
    """
    foreground = flags.get("f") is True
    preserve = flags.get("p") is True
    verbose = flags.get("v") is True
    session = context.session
    console = PipeConsole()
    held: list[IOResult] = []
    ran: list[tuple[bytes | None, IOResult]] = []
    child = child_context(context)
    syntax = session._line_node

    def killed(number: int) -> str:
        return _killed_report(context, syntax, process, number, foreground)

    def hold_job() -> None:
        _hold_job(processes, process, syntax)

    async def run() -> int:
        token = set_current_evaluation(child)
        # timeout execs its command, so a builtin that is also a program
        # answers as the program.
        program = set_program_invocation(child.session)
        try:
            ran.append(
                await _execute_drained(
                    execute_fn, inner, session.session_id, stdin, console, held
                )
            )
        finally:
            reset_program_invocation(program)
            reset_current_session(token)
            await child.session.close_inputs()
        return ran[0][1].exit_code

    def forked(process: ProcessHandle) -> None:
        child.session.process_id = process.record.pid
        child.frame.shell = process

    try:
        process = processes.start(
            session_id=session.session_id,
            command=inner,
            cwd=PathSpec.from_str_path(session.cwd),
            parent=session.process_id,
            run=run,
            limit=session.processes.max,
            started=forked,
            ignores=SHELL_IGNORED_SIGNALS,
            own_group=not foreground,
            one_command=True,
        )
    except BlockingIOError:
        return _refuse(FORK_FAILED)

    async def watch() -> Result:
        # The deadline's answer, then the run's stdout ends, whatever the
        # deadline answered.
        try:
            return await _deadline(
                processes,
                process,
                ran,
                console,
                held,
                seconds,
                signal,
                kill_after,
                foreground,
                preserve,
                verbose,
                name,
                killed,
                hold_job,
            )
        finally:
            if not process.task.done():
                await _cancel(process.task)
            console.end()

    watching = asyncio.ensure_future(watch())
    io = IOResult()
    io.output = state = OutputState()
    node = ExecutionNode(command="timeout")

    async def close() -> None:
        # A reader that stops early, or never starts, closes the pipe, so
        # the line's next write fails as a write to a closed pipe does and
        # the run is let go. The line ran under the command's prefix
        # assignments, which end as this settles.
        console.close_reader()
        if not watching.done():
            await _cancel(watching)
        elif not watching.cancelled() and watching.exception() is not None:
            logger.debug("timeout: the run ended: %s", watching.exception())
        state.finish()

    return (
        OutputStream(_streamed(console, watching, io, node), close),
        io,
        node,
    )


async def _streamed(
    console: PipeConsole,
    watch: asyncio.Future[Result],
    io: IOResult,
    node: ExecutionNode,
) -> AsyncIterator[bytes]:
    """The inner line's stdout as it writes it; once it ends, timeout's
    status and stderr settle on `io` and `node`.

    Args:
        console (PipeConsole): where the line writes.
        watch (asyncio.Future[Result]): the deadline's watch over the
            run.
        io (IOResult): timeout's result, settled at the end.
        node (ExecutionNode): timeout's node, settled at the end.
    """
    async for chunk in console.stream():
        yield chunk
    _, result, _ = await watch
    io.exit_code = node.exit_code = result.exit_code
    io.stderr = result.stderr


async def _deadline(
    processes: ProcessTable,
    process: ProcessHandle,
    ran: list[tuple[bytes | None, IOResult]],
    console: JobConsole,
    held: list[IOResult],
    seconds: float,
    signal: int,
    kill_after: float,
    foreground: bool,
    preserve: bool,
    verbose: bool,
    name: str,
    killed: Callable[[int], str],
    hold_job: Callable[[], None],
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Wait for the run, and at the deadline do what the signal does.

    Args:
        processes (ProcessTable): the table the command runs in.
        process (ProcessHandle): the command's process.
        ran (list[tuple[bytes | None, IOResult]]): its drained output
            and result, once it ended on its own.
        console (JobConsole): what it printed so far.
        held (list[IOResult]): its result, once it existed.
        seconds (float): the deadline; 0 (or inf) is none.
        signal (int): the signal sent at the deadline.
        kill_after (float): -k, how long until KILL follows; 0 is never.
        foreground (bool): --foreground, which signals the command only.
        preserve (bool): --preserve-status.
        verbose (bool): -v, which says each signal sent.
        name (str): the command word, which -v names.
        killed (Callable[[int], str]): bash's report of timeout dying of
            a signal.
        hold_job (Callable[[], None]): holds the job of a timeout that
            stopped itself.
    """
    task = process.task
    deadline = seconds if 0 < seconds < math.inf else None
    done, _ = await asyncio.wait({task}, timeout=deadline)
    if task not in done and process.paused:
        # A stopped timeout takes its alarm once it goes on.
        resumed = asyncio.ensure_future(process.resumed())
        either: set[asyncio.Task[Any]] = {task, resumed}
        done, _ = await asyncio.wait(
            either, return_when=asyncio.FIRST_COMPLETED
        )
        resumed.cancel()
    if task in done:
        task.result()
        stdout, io = ran[0]
        return (
            stdout,
            io,
            ExecutionNode(command="timeout", exit_code=io.exit_code),
        )

    said: list[str] = []

    def say(number: int) -> None:
        if verbose:
            said.append(
                f"timeout: sending signal {signal_name(number)} to "
                f"command '{quote_text(name)}'\n"
            )

    say(signal)
    stops = signal in STOP_SIGNALS and (foreground or signal == SIGSTOP)
    ignored = signal in process.ignores
    # A foreground command Mirage runs itself stops at a terminal stop as
    # at STOP; an asynchronous one ignores those.
    sent = SIGSTOP if stops and not process.record.is_program else signal
    await _signal(processes, process, sent, foreground)
    if not foreground and signal == SIGSTOP:
        hold_job()
    if not foreground and signal in (SIGSTOP, SIGCHLD):
        # timeout stopped itself, or never wakes: only -k's KILL ends the
        # wait, and not even that once it stopped itself.
        if kill_after == 0 or signal == SIGSTOP:
            await asyncio.get_running_loop().create_future()
        await asyncio.sleep(kill_after)
        if not task.done():
            await _signal(processes, process, SIGKILL, foreground)
        say(SIGKILL)
        said.append(killed(SIGKILL))
        return await _ended(console, held, said, 137)
    done, _ = await asyncio.wait({task}, timeout=kill_after or None)
    if task not in done:
        await _signal(processes, process, SIGKILL, foreground)
        say(SIGKILL)
        said.append(killed(SIGKILL))
        return await _ended(console, held, said, 137)
    if signal in CONTINUE_SIGNALS or signal in STOP_SIGNALS or ignored:
        code = task.result() if preserve else TIMEOUT_STATUS
        return await _ended(console, held, said, code, finished=True)
    if signal in SELF_KILLING_SIGNALS and (
        not foreground or signal == SIGKILL
    ):
        said.append(killed(signal))
        return await _ended(console, held, said, 128 + signal)
    if not task.cancelled():
        code = task.result() if preserve else TIMEOUT_STATUS
        return await _ended(console, held, said, code, finished=True)
    return await _ended(
        console, held, said, 128 + signal if preserve else TIMEOUT_STATUS
    )


def _ends_line(node: TSNodeLike) -> bool:
    root = node
    while root.parent is not None:
        root = root.parent
    return not (root.text or b"")[node.end_byte - root.start_byte :].strip()


def _killed_report(
    context: EvaluationContext,
    node: TSNodeLike | None,
    process: ProcessHandle,
    number: int,
    foreground: bool,
) -> str:
    """bash's report of timeout dying of the signal it sent its own
    group, which --foreground does not. None where the shell would not
    tell it here: in a substitution, under the command's own redirect,
    or for a line's last command, which bash runs in its own place.

    Args:
        context (EvaluationContext): the caller's evaluation.
        node (TSNodeLike | None): the timeout command.
        process (ProcessHandle): the command's process.
        number (int): the signal.
        foreground (bool): --foreground.
    """
    if (
        foreground
        or node is None
        or context.frame.substitution
        or redirected_body(node)
        or _ends_line(node)
    ):
        return ""
    row = (process.record.pid, 128 + number, number, reported_command(node))
    return signal_report(shell_voice(), [row], True)


def _hold_job(
    processes: ProcessTable,
    process: ProcessHandle,
    syntax: TSNodeLike | None,
) -> None:
    # A job that is timeout alone is what stopped itself.
    record = process.record
    job = (
        None
        if record.parent is None
        else processes.target(
            record.parent, record.session_id, ProcessPermissions()
        )
    )
    if (
        job is not None
        and job.background
        and syntax is not None
        and job.record.command == get_text(syntax)
    ):
        processes.pause(job)


async def _signal(
    processes: ProcessTable,
    process: ProcessHandle,
    signal: int,
    foreground: bool,
) -> None:
    # What `kill` does to the command, or to its process group unless
    # --foreground, so what the command started gets it too. That group
    # then gets CONT, so one that was stopped takes the signal.
    if foreground:
        await processes.signal(process, signal, group=True)
        return
    group = process.record.group
    await processes.signal_group(group, signal)
    if signal not in (SIGKILL, SIGCONT, SIGSTOP):
        await processes.signal_group(group, SIGCONT)


async def _cancel(task: asyncio.Future[Any]) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _ended(
    console: JobConsole,
    held: list[IOResult],
    said: list[str],
    exit_code: int,
    finished: bool = False,
) -> tuple[bytes | None, IOResult, ExecutionNode]:
    """What a run the deadline reached leaves behind.

    What the command printed before it ended is its output, as GNU
    leaves it on the terminal; only the run past that is lost. That goes
    for stderr too: a `tail -F missing` has already said it cannot open
    the file by the time the deadline kills it. timeout's own -v lines
    follow it.

    Args:
        console (JobConsole): what the command printed.
        held (list[IOResult]): the inner result, once it existed.
        said (list[str]): timeout's own -v lines.
        exit_code (int): timeout's exit status.
        finished (bool): whether the run ended on its own, so its result
            holds its whole stderr, what it wrote into the console too.
    """
    stderr = held[0].stderr if held else None
    if finished:
        head = await materialize(stderr)
    else:
        head = await console.snapshot(Channel.STDERR) + (
            stderr if isinstance(stderr, bytes) else b""
        )
    tail = encode_text("".join(said))
    out = await console.snapshot(Channel.STDOUT) or None
    return (
        out,
        IOResult(exit_code=exit_code, stderr=head + tail or None),
        ExecutionNode(command="timeout", exit_code=exit_code),
    )


async def _execute_drained(
    execute_fn: Callable[..., Any],
    inner: str,
    session_id: str,
    stdin: ByteSource | None,
    console: JobConsole,
    held: list[IOResult],
) -> tuple[bytes | None, IOResult]:
    """Run the inner line and drain its output under the same deadline.

    The line writes into ``console`` as it runs, a program as it prints
    and a list statement by statement, so a run the deadline cuts short
    keeps what it had printed, as GNU's leaves it on the terminal. A
    lazy stdout it still returns drains inside the deadline too. The
    inner result lands in ``held`` as soon as it exists.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        inner (str): the joined command line.
        session_id (str): session to run in.
        stdin (ByteSource | None): what the command reads.
        console (JobConsole): where the line writes as it runs.
        held (list[IOResult]): one-slot box the inner result lands in.
    """
    extra = {"stdin": stdin} if stdin is not None else {}
    io = await execute_fn(inner, session_id=session_id, sink=console, **extra)
    held.append(io)
    if io.stdout is not None:
        async for chunk in ensure_stream(io.stdout):
            await console.emit(Channel.STDOUT, chunk)
    io.stderr = (
        await console.snapshot(Channel.STDERR)
        + (await io.materialize_stderr())
        or None
    )
    out = await console.snapshot(Channel.STDOUT)
    return out if out or io.stdout is not None else None, io


async def timeout_builtin(call: BuiltinCall) -> Result:
    """The ``timeout`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_timeout(
        call.execute_fn,
        list(call.argv.args),
        call.context,
        call.stdin,
        call.registry,
        call.job_table.processes if call.job_table is not None else None,
    )
