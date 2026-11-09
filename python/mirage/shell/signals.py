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
import re
from collections.abc import Sequence

from mirage.shell.constants import (
    SIGNAL_DESCRIPTIONS,
    SIGNALS,
    SIGRTMAX,
    SIGRTMIN,
    SIGTERM,
    UNREPORTED_SIGNALS,
)

_NUMBER = re.compile(r"\s*\+?([0-9]+)")
_RTMIN = re.compile(r"RTMIN\+([0-9]+)")
_RTMAX = re.compile(r"RTMAX-([0-9]+)")

# The realtime numbers named from RTMIN in `kill -l`; the rest are named
# from RTMAX.
_RTMIN_NAMED = 15


def signal_name(number: int) -> str | None:
    """The name bash's ``kill -l`` gives a signal, without ``SIG``: None
    for a number it names nothing (32 and 33).

    Args:
        number (int): the signal number, 1 to 64.
    """
    if number in SIGNALS:
        return SIGNALS[number]
    if not SIGRTMIN <= number <= SIGRTMAX:
        return None
    if number == SIGRTMIN:
        return "RTMIN"
    if number == SIGRTMAX:
        return "RTMAX"
    if number - SIGRTMIN <= _RTMIN_NAMED:
        return f"RTMIN+{number - SIGRTMIN}"
    return f"RTMAX-{SIGRTMAX - number}"


def signal_number(spec: str) -> int | None:
    """The signal a bash sigspec names, None if it names none.

    Measured on bash 5.2: a number may lead with blanks and ``+`` and
    names any signal up to 64; a name is read in any case, with or
    without ``SIG``, ``EXIT`` is 0, ``RTMIN+n`` reaches up to RTMAX and
    ``RTMAX-n`` is only the names ``kill -l`` lists.

    Args:
        spec (str): the sigspec as typed.
    """
    if not spec.isascii():
        return None
    number = _NUMBER.fullmatch(spec)
    if number is not None:
        value = int(number.group(1))
        return value if value <= SIGRTMAX else None
    name = spec.upper()
    if name.startswith("SIG"):
        name = name[3:]
    if name == "EXIT":
        return 0
    for value, known in SIGNALS.items():
        if known == name:
            return value
    if name == "RTMIN":
        return SIGRTMIN
    if name == "RTMAX":
        return SIGRTMAX
    offset = _RTMIN.fullmatch(name)
    if offset is not None and int(offset.group(1)) <= SIGRTMAX - SIGRTMIN:
        return SIGRTMIN + int(offset.group(1))
    offset = _RTMAX.fullmatch(name)
    if offset is not None:
        value = SIGRTMAX - int(offset.group(1))
        return value if signal_name(value) == name else None
    return None


def listed_signal(word: str) -> str | None:
    """What ``kill -l`` prints for one operand: a number's name (one of
    128 plus a signal names that signal, as a ``$?`` does), empty for a
    number naming nothing (32 and 33), a name's number; None for a word
    that names no signal.

    Args:
        word (str): the operand as typed.
    """
    number = _NUMBER.fullmatch(word) if word.isascii() else None
    if number is None:
        value = signal_number(word)
        return None if value is None else str(value)
    value = int(number.group(1))
    if 128 < value <= 128 + SIGRTMAX:
        value -= 128
    elif value > SIGRTMAX:
        return None
    return "EXIT" if value == 0 else signal_name(value) or ""


def signal_description(number: int) -> str | None:
    """How bash's report line names a signal that ended a command, None
    for one whose default never ends a process.

    Args:
        number (int): the signal number.
    """
    if number in SIGNAL_DESCRIPTIONS:
        return SIGNAL_DESCRIPTIONS[number]
    if SIGRTMIN <= number <= SIGRTMAX:
        return f"Real-time signal {number - SIGRTMIN}"
    return None


def signal_table() -> str:
    """bash's ``kill -l`` listing: every named signal as ``N) SIGNAME``,
    five to a line, a tab after each but the fifth."""
    entries = [
        f"{number:2d}) SIG{name}"
        for number in range(1, SIGRTMAX + 1)
        if (name := signal_name(number)) is not None
    ]
    lines = [
        "\t".join(entries[start : start + 5])
        for start in range(0, len(entries), 5)
    ]
    tail = "\t" if len(entries) % 5 else ""
    return "\n".join(lines) + tail + "\n"


def process_status(code: int, signal: int | None) -> str:
    """How bash's report names how a process ended: the signal's
    description, ``Done`` or ``Exit N``.

    Args:
        code (int): the exit status.
        signal (int | None): the signal that ended it, None for an exit.
    """
    if signal is not None:
        described = signal_description(signal)
        if described is not None:
            return described
    return "Done" if code == 0 else f"Exit {code}"


def signal_reported(signal: int | None) -> bool:
    """Whether bash's report of a job lists its processes: a signal
    other than INT, PIPE and TERM ended its last one.

    Args:
        signal (int | None): the signal that ended the last process,
            None for an exit.
    """
    return (
        signal is not None
        and signal not in UNREPORTED_SIGNALS
        and signal != SIGTERM
    )


def signal_report(
    voice: str,
    processes: Sequence[tuple[int, int, int | None, str]],
    foreground: bool,
) -> str:
    """bash's report of a job a signal ended, one line per process: the
    first after the shell's voice, the rest indented after a ``|``, each
    status the process before gave left blank. Empty unless a signal
    ended the last process; INT and PIPE end it unreported, and TERM as
    ``Terminated`` alone in the foreground and unreported behind it.

    Args:
        voice (str): the shell's voice (``bash: line 1: ``).
        processes (Sequence[tuple[int, int, int | None, str]]): each
            process's pid, exit status, the signal that ended it (None
            for an exit) and command.
        foreground (bool): the shell waited for the job as it ran.
    """
    signal = processes[-1][2]
    if signal == SIGTERM:
        return "Terminated\n" if foreground else ""
    if not signal_reported(signal):
        return ""
    lines = []
    before = None
    for pid, code, ended, command in processes:
        status = process_status(code, ended)
        if before is None:
            lines.append(f"{voice}{pid:5d} {status:<24}{command}")
        elif status == before:
            lines.append(f"     {pid:5d} {'':22}| {command}")
        else:
            lines.append(f"     {pid:5d} {status:<24}| {command}")
        before = status
    return "\n".join(lines) + "\n"
