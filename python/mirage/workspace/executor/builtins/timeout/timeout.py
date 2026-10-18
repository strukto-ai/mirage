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
import math
import re
from collections.abc import Callable
from typing import Any

from mirage.commands.builtin.utils.strtod import STRTOD, strtod_double
from mirage.commands.builtin.utils.strtol import INT_MAX, bounded_decimal
from mirage.commands.quote import quote_text
from mirage.commands.spec.help import render_help
from mirage.commands.spec.shell import SHELL_SPECS, parse_shell_options
from mirage.commands.spec.standard import version_line
from mirage.commands.spec.usage import (
    ambiguous_option_error,
    missing_value_error,
    unexpected_value_error,
    unknown_option_error,
    usage_hint,
)
from mirage.context import reset_program_invocation, set_program_invocation
from mirage.io import IOResult
from mirage.io.stream import ensure_stream, materialize, yield_bytes
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.shell.join import shell_join
from mirage.workspace.executor.builtins.timeout.constants import (
    CONTINUE_SIGNALS,
    SELF_KILLING_SIGNALS,
    SIGCHLD,
    SIGKILL,
    SIGNAL_ALIASES,
    SIGNALS,
    SIGRTMAX,
    SIGRTMIN,
    SIGSTOP,
    STOP_SIGNALS,
    TIMEOUT_NAMES,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup.lookup import execs
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

_SYNOPSIS = "timeout [OPTION] DURATION COMMAND [ARG]..."

_UNIT_SECONDS = {"": 1.0, "s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}

_Run = asyncio.Future[tuple[bytes | None, IOResult]]


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
    session: SessionState,
    stdin: ByteSource | None = None,
    registry: MountRegistry | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run `timeout [OPTION] DURATION COMMAND [ARG...]` (GNU timeout).

    The inner line is built with shell_join so already-expanded words
    survive re-parsing as one token each (GNU timeout execs the command
    without a shell). The command reads timeout's stdin. At the deadline
    the command gets -s's signal (TERM by default), and a command here
    is a task, not a process, so the signal's default action decides:
    one that terminates ends the run, and 124 reports it, or the status
    a shell would show with --preserve-status; one that is ignored (0,
    CHLD, CONT, URG, WINCH) lets the run carry on, and -k's KILL ends it
    later with 137; a stop halts it until that KILL. timeout signals its
    own process group unless --foreground, so it dies of what it cannot
    ignore (KILL, 32, 33), stops itself on STOP, and never wakes after
    CHLD; each ends as GNU's does. -v says each signal on stderr.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): options, duration operand, then the command.
        session (SessionState): shell session state.
        stdin (ByteSource | None): what the command reads.
        registry (MountRegistry | None): where the command name is
            looked up; None runs every name.
    """
    parse = parse_shell_options(SHELL_SPECS["timeout"], args or [])
    signal = 15
    kill_after = 0.0
    for name, value in parse.given:
        if name == "help":
            text = encode_text(
                render_help(
                    "timeout", SHELL_SPECS["timeout"], synopsis=_SYNOPSIS
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
        return _refuse(encode_text(timeout_missing(command[0])), 127)
    return await _supervise(
        execute_fn,
        shell_join(command),
        session,
        stdin,
        seconds,
        signal,
        kill_after,
        parse.flags,
        command[0],
    )


async def _supervise(
    execute_fn: Callable[..., Any],
    inner: str,
    session: SessionState,
    stdin: ByteSource | None,
    seconds: float,
    signal: int,
    kill_after: float,
    flags: dict[str, str | bool],
    name: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the inner line under the deadline and answer as GNU does.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        inner (str): the joined command line.
        session (SessionState): shell session state.
        stdin (ByteSource | None): what the command reads.
        seconds (float): the deadline; 0 (or inf) is none.
        signal (int): the signal sent at the deadline.
        kill_after (float): -k, how long until KILL follows; 0 is never.
        flags (dict[str, str | bool]): the parsed options.
        name (str): the command word, which -v names.
    """
    foreground = flags.get("f") is True
    preserve = flags.get("p") is True
    verbose = flags.get("v") is True
    drained: list[bytes] = []
    held: list[IOResult] = []
    # timeout execs its command, so a builtin that is also a program
    # answers as the program. The task copies the context it starts in.
    token = set_program_invocation(session)
    try:
        task = asyncio.ensure_future(
            _execute_drained(
                execute_fn, inner, session.session_id, stdin, drained, held
            )
        )
    finally:
        reset_program_invocation(token)
    try:
        return await _deadline(
            task,
            drained,
            held,
            seconds,
            signal,
            kill_after,
            foreground,
            preserve,
            verbose,
            name,
        )
    finally:
        if not task.done():
            await _cancel(task)


async def _deadline(
    task: _Run,
    drained: list[bytes],
    held: list[IOResult],
    seconds: float,
    signal: int,
    kill_after: float,
    foreground: bool,
    preserve: bool,
    verbose: bool,
    name: str,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Wait for the run, and at the deadline do what the signal does.

    Args:
        task (_Run): the running inner line.
        drained (list[bytes]): the stdout chunks it printed so far.
        held (list[IOResult]): its result, once it existed.
        seconds (float): the deadline; 0 (or inf) is none.
        signal (int): the signal sent at the deadline.
        kill_after (float): -k, how long until KILL follows; 0 is never.
        foreground (bool): --foreground, which signals the command only.
        preserve (bool): --preserve-status.
        verbose (bool): -v, which says each signal sent.
        name (str): the command word, which -v names.
    """
    deadline = seconds if 0 < seconds < math.inf else None
    done, _ = await asyncio.wait({task}, timeout=deadline)
    if task in done:
        stdout, io = task.result()
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
    if stops or (signal == SIGCHLD and not foreground):
        # The command stops, or timeout never wakes: only -k's KILL
        # ends the wait, and not even that once timeout stopped itself.
        if stops:
            await _cancel(task)
        if kill_after == 0 or (signal == SIGSTOP and not foreground):
            await asyncio.get_running_loop().create_future()
        await asyncio.sleep(kill_after)
        if not task.done():
            await _cancel(task)
        say(SIGKILL)
        return await _ended(drained, held, said, 137)
    if signal in CONTINUE_SIGNALS or signal in STOP_SIGNALS:
        done, _ = await asyncio.wait(
            {task}, timeout=kill_after if kill_after else None
        )
        if task not in done:
            await _cancel(task)
            say(SIGKILL)
            return await _ended(drained, held, said, 137)
        code = task.result()[1].exit_code if preserve else 124
        return await _ended(drained, held, said, code, finished=True)
    await _cancel(task)
    if signal in SELF_KILLING_SIGNALS and (
        not foreground or signal == SIGKILL
    ):
        return await _ended(drained, held, said, 128 + signal)
    return await _ended(drained, held, said, 128 + signal if preserve else 124)


async def _cancel(task: _Run) -> None:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def _ended(
    drained: list[bytes],
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
        drained (list[bytes]): the stdout chunks the command printed.
        held (list[IOResult]): the inner result, once it existed.
        said (list[str]): timeout's own -v lines.
        exit_code (int): timeout's exit status.
        finished (bool): whether the run ended on its own, so its stderr
            is complete and can be read in full.
    """
    stderr = held[0].stderr if held else None
    if finished:
        stderr = await materialize(stderr)
    tail = encode_text("".join(said))
    head = stderr if isinstance(stderr, bytes) else b""
    out = b"".join(drained) or None
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
    drained: list[bytes],
    held: list[IOResult],
) -> tuple[bytes | None, IOResult]:
    """Run the inner line and drain its stdout under the same deadline.

    A lazy inner pipeline produces bytes only when consumed; draining
    inside the deadline keeps the whole run under the limit, and
    draining chunk by chunk into ``drained`` is what lets a run that
    overruns keep what it had printed. The inner result lands in
    ``held`` as soon as it exists, so its stderr survives the deadline
    the same way.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        inner (str): the joined command line.
        session_id (str): session to run in.
        stdin (ByteSource | None): what the command reads.
        drained (list[bytes]): where each chunk lands as it arrives.
        held (list[IOResult]): one-slot box the inner result lands in.
    """
    extra = {"stdin": stdin} if stdin is not None else {}
    io = await execute_fn(inner, session_id=session_id, **extra)
    held.append(io)
    if io.stdout is not None:
        async for chunk in ensure_stream(io.stdout):
            drained.append(chunk)
    return b"".join(drained) if drained or io.stdout is not None else None, io


async def timeout_builtin(call: BuiltinCall) -> Result:
    """The ``timeout`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_timeout(
        call.execute_fn,
        list(call.argv.args),
        call.context.session,
        call.stdin,
        call.registry,
    )
