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
import logging
import re
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
    Awaitable,
    Callable,
)
from contextlib import aclosing
from dataclasses import dataclass, field
from typing import Any, Literal

from mirage.commands.errors import UsageError
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
from mirage.concurrency.limiter import bounded_map_stream
from mirage.context import (
    reset_current_session,
    reset_program_invocation,
    set_current_evaluation,
    set_program_invocation,
)
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import enoent, fs_strerror
from mirage.io import IOResult
from mirage.io.cooperative import chunks
from mirage.io.errors import PipeClosed
from mirage.io.stream import SharedStdin, yield_bytes
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.constants import (
    NOT_FOUND_STATUS,
    SIGPIPE_STATUS,
    TIMEOUT_STATUS,
)
from mirage.shell.join import shell_join
from mirage.utils.quote import shell_quote
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.script.script import read_script_bytes
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.jobs import pump
from mirage.workspace.lookup.lookup import execs
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import env_snapshot
from mirage.workspace.types import ExecutionNode

logger = logging.getLogger(__name__)

_SYNOPSIS = "xargs [OPTION]... COMMAND [INITIAL-ARGS]..."

# The sizes GNU findutils 4.10 reports with --show-limits on Linux with
# an 8 MiB stack: exec takes 2 MiB of arguments and environment, 2 KiB of
# which xargs leaves unused, and a command line holds 128 KiB unless -s
# says otherwise. -P takes at most a C int.
_EXEC_BYTES = 2097152
_UNUSED_BYTES = 2048
_POSIX_FLOOR = 4096
_STANDARD_WIDTH = 131072
_MOST_JOBS = 2147483647

_INTEGER = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")
# Runs of bytes the quoting reader copies as they are: outside quotes,
# inside a whole -I line once it has begun, and inside each quote.
_WORD_RUN = re.compile(rb"[^ \t\n'\"\\\x00]+")
_LINE_RUN = re.compile(rb"[^\n'\"\\\x00]+")
_QUOTED_RUN = {
    0x27: re.compile(rb"[^'\n\x00]+"),
    0x22: re.compile(rb'[^"\n\x00]+'),
}
_QUOTE_WORDS = {0x27: "single", 0x22: "double"}
# Vertical tab, form feed and carriage return are skipped before a word
# but kept inside one (GNU 4.10: `\ra \vb\r` gives `a` and `b\r`), and
# skipping one leaves a line's last blank as it was for -L.
_SKIPPED_BEFORE_WORD = b"\x0b\x0c\x0d"
_LETTER_ESCAPES = {
    0x61: 0x07,
    0x62: 0x08,
    0x66: 0x0C,
    0x6E: 0x0A,
    0x72: 0x0D,
    0x74: 0x09,
    0x76: 0x0B,
    0x5C: 0x5C,
}
_HEX_DIGITS = b"0123456789abcdefABCDEF"
_OCTAL_DIGITS = b"01234567"

_NUL_IN_INPUT = (
    "xargs: WARNING: a NUL character occurred in the input.  It cannot be "
    "passed through in the argument list.  Did you mean to use the --null "
    "option?\n"
)
_NO_TTY = (
    "xargs: failed to open /dev/tty for reading: No such device or address\n"
)
_LINE_TOO_LONG = "xargs: argument line too long\n"
_LIST_TOO_LONG = "xargs: argument list too long\n"
_NO_ROOM = (
    "xargs: cannot fit single argument within argument list size limit\n"
)
_TEMPLATE_TOO_LONG = "xargs: command too long\n"
_CROWDED = "xargs: environment is too large for exec\n"
_Grouping = Literal["template", "lines", "group"]
# What a previous -I, -L or -n is called when a later one cancels it.
_CANCELLED: dict[_Grouping, str] = {
    "template": "--replace",
    "lines": "--max-lines",
    "group": "--max-args",
}


def _refusal(stderr: str | bytes, code: int = 1) -> Result:
    data = encode_text(stderr) if isinstance(stderr, str) else stderr
    return (
        None,
        IOResult(stderr=data, exit_code=code),
        ExecutionNode(command="xargs", exit_code=code),
    )


def _answer(option: str, notes: str) -> Result:
    # --help and --version answer where they stand, after the warnings of
    # the options before them.
    if option == "help":
        text = encode_text(
            render_help("xargs", SHELL_SPECS["xargs"], synopsis=_SYNOPSIS)
        )
    else:
        text = version_line("xargs")
    return (
        yield_bytes(text),
        IOResult(stderr=encode_text(notes) or None),
        ExecutionNode(command="xargs", exit_code=0),
    )


def _conflict(option: str, previous: str) -> str:
    return (
        f"xargs: warning: options {previous} and {option} are mutually "
        f"exclusive, ignoring previous {previous} value\n"
    )


def _whole_number(
    raw: str, letter: str, floor: int, ceiling: int | None = None
) -> int:
    """Read a count option as GNU does: blanks may lead, nothing may trail.

    Args:
        raw (str): the option's value.
        letter (str): the option letter the diagnostics name.
        floor (int): the smallest value taken.
        ceiling (int | None): the largest value taken; None has no bound,
            so GNU 4.10 runs ``-n 99999999999999999999``.
    """
    hint = usage_hint("xargs")
    if not _INTEGER.fullmatch(raw):
        raise UsageError(
            f'xargs: invalid number "{raw}" for -{letter} option\n{hint}\n', 1
        )
    value = int(raw)
    if value < floor:
        raise UsageError(
            f"xargs: value {raw} for -{letter} option should be "
            f">= {floor}\n{hint}\n",
            1,
        )
    if ceiling is not None and value > ceiling:
        raise UsageError(
            f"xargs: value {raw} for -{letter} option should be "
            f"<= {ceiling}\n{hint}\n",
            1,
        )
    return value


def _separator(spec: str) -> int:
    """The byte -d names: one character, or a backslash escape.

    A letter escape ignores what follows it (GNU 4.10 takes ``\\nX`` as
    newline); a numeric one (``\\x41``, ``\\101``) reads every digit of
    its base, so ``\\x411`` is out of range and ``\\x41z`` has a tail.

    Args:
        spec (str): the option's value.
    """
    raw = encode_text(spec)
    if len(raw) == 1:
        return raw[0]
    if not raw.startswith(b"\\"):
        raise UsageError(
            f"xargs: Invalid input delimiter specification {spec}: the "
            "delimiter must be either a single character or an escape "
            "sequence starting with \\.\n",
            1,
        )
    lead = raw[1]
    if lead in _LETTER_ESCAPES:
        return _LETTER_ESCAPES[lead]
    if lead == 0x78:
        digits, body, top = _HEX_DIGITS, raw[2:], ("ff", 16)
    elif 0x30 <= lead <= 0x39:
        digits, body, top = _OCTAL_DIGITS, raw[1:], ("377", 8)
    else:
        raise UsageError(
            f"xargs: Invalid escape sequence {spec} in input delimiter "
            "specification.\n",
            1,
        )
    width = 0
    while width < len(body) and body[width] in digits:
        width += 1
    value = int(body[:width], top[1]) if width else 0
    if value > 0xFF:
        raise UsageError(
            f"xargs: Invalid escape sequence {spec} in input delimiter "
            f"specification; character values must not exceed {top[0]}.\n",
            1,
        )
    if width < len(body):
        raise UsageError(
            f"xargs: Invalid escape sequence {spec} in input delimiter "
            "specification; trailing characters "
            f"{decode_text(body[width:])} not recognised.\n",
            1,
        )
    return value


def _limits_report(environment: int, room: int, width: int) -> str:
    return (
        f"Your environment variables take up {environment} bytes\n"
        "POSIX upper limit on argument length (this system): "
        f"{room}\n"
        "POSIX smallest allowable upper limit on argument length "
        f"(all systems): {_POSIX_FLOOR}\n"
        "Maximum length of command we could actually use: "
        f"{room - environment}\n"
        f"Size of command buffer we are actually using: {width}\n"
        "Maximum parallelism (--max-procs must be no greater): "
        f"{_MOST_JOBS}\n"
    )


def _tty_abort(name: bytes) -> str:
    # GNU 4.10 without a terminal: the child cannot reopen /dev/tty and
    # dies of SIGABRT, which xargs reports as 125.
    return (
        "xargs: '/dev/tty': No such device or address\n"
        "xargs: xargs.c:1648: wait_for_proc_all: Assertion "
        "`getpid () == parent' failed.\n"
        f"xargs: {decode_text(name)}: terminated by signal 6\n"
    )


def _unclosed(mark: int) -> str:
    return (
        f"xargs: unmatched {_QUOTE_WORDS[mark]} quote; by default quotes "
        "are special to xargs unless you use the -0 option\n"
    )


def _before_nul(word: bytes) -> bytes:
    # An argument is a C string: a NUL ends it, though every byte read
    # still counts against -s (GNU 4.10: `a\0bbbbbbbbbbbb` needs 15).
    cut = word.find(b"\0")
    return word if cut < 0 else word[:cut]


@dataclass
class _Plan:
    """What the options asked for, in the order they were given.

    -I (``template``), -L/-l (``lines``) and -n (``group``) exclude one
    another: the last one given holds, with a warning for the one it
    cancels, except that ``-n 1`` after -I is ignored silently.

    Args:
        room (int): what -s may reach once the environment is counted.
        crowded (bool): the environment alone leaves no room.
    """

    room: int
    crowded: bool
    notes: str = ""
    width: int = 0
    separator: int | None = None
    end_word: str | None = None
    template: str | None = None
    lines: int = 0
    group: int = 0
    jobs: int = 1
    source: str = "-"
    slot_var: str | None = None
    flags: set[str] = field(default_factory=set)

    def active(self) -> _Grouping | None:
        if self.template is not None:
            return "template"
        if self.lines:
            return "lines"
        return "group" if self.group else None

    def warn_over(self, option: str, *kinds: _Grouping) -> None:
        held = self.active()
        if held is not None and held in kinds:
            self.notes += _conflict(option, _CANCELLED[held])

    def take(self, name: str, value: str | None) -> None:
        if name == "0":
            self.separator = 0
        elif name == "d" and value is not None:
            self.separator = _separator(value)
        elif name in ("E", "e"):
            self.end_word = value or None
        elif name in ("t", "p", "x", "o", "r", "show-limits"):
            self.flags.add(name)
        elif name == "a" and value is not None:
            self.source = value
        elif name == "process-slot-var" and value is not None:
            self.take_slot_var(value)
        elif name == "s" and value is not None:
            self.take_width(value)
        elif name in ("I", "i"):
            self.warn_over("--replace/-I/-i", "group", "lines")
            self.template = "{}" if value is None else value
            self.lines = self.group = 0
        elif name in ("L", "l"):
            count = _whole_number("1" if value is None else value, name, 1)
            label = "-L" if name == "L" else "--max-lines/-l"
            self.warn_over(label, "group", "template")
            self.template, self.lines, self.group = None, count, 0
        elif name == "n" and value is not None:
            self.take_group(_whole_number(value, "n", 1))
        elif name == "P" and value is not None:
            self.jobs = _whole_number(value, "P", 0, _MOST_JOBS)

    def take_group(self, count: int) -> None:
        held = self.active()
        if held == "template" and count == 1:
            # GNU reads `-I {} -n1` as plain -I.
            return
        self.warn_over("--max-args/-n", "lines", "template")
        self.template, self.lines, self.group = None, 0, count

    def take_width(self, value: str) -> None:
        if self.crowded:
            raise UsageError(_CROWDED, 1)
        if not _INTEGER.fullmatch(value):
            raise UsageError(
                f'xargs: invalid number "{value}" for -s option\n'
                f"{usage_hint('xargs')}\n",
                1,
            )
        width = int(value)
        if width < 1:
            self.notes += (
                f"xargs: value {value} for -s option should be >= 1\n"
            )
            width = 1
        elif width > self.room:
            self.notes += (
                f"xargs: value {value} for -s option should be "
                f"<= {self.room}\n"
            )
            width = self.room
        self.width = width

    def take_slot_var(self, value: str) -> None:
        if "=" in value:
            raise UsageError(
                "xargs: option --process-slot-var may not be set to a value "
                "which includes `='\n",
                1,
            )
        if not value:
            raise UsageError(
                "xargs: failed to unset environment variable : Invalid "
                "argument\n",
                1,
            )
        self.slot_var = value


class _Collector:
    """Where the reader's words go: commands to run and messages to print,
    in order, and the error that ended the run.

    Args:
        base (list[bytes]): the command name and its initial arguments.
        width (int): the -s limit in bytes, a NUL counted per word.
        flags (set[str]): -p asks first and -o reopens the terminal; there
            is no terminal, so the first command fails each way.
    """

    def __init__(self, base: list[bytes], width: int, flags: set[str]) -> None:
        self.base = base
        self.width = width
        self.ask = "p" in flags
        self.reopen = "o" in flags
        self.traced = "t" in flags
        self.out: list[str | list[bytes]] = []
        self.failure: tuple[str, int] | None = None
        self.ended = False
        self.waiting = False

    def halted(self) -> bool:
        return self.ended

    def holding(self) -> bool:
        # A built command waits to be run: the reader pauses until it has
        # been handed on, so one is held at a time.
        return self.waiting

    def drain(self) -> list[str | list[bytes]]:
        ready, self.out = self.out, []
        self.waiting = False
        return ready

    def note(self, text: str) -> None:
        self.out.append(text)

    def stop(self, text: str, code: int = 1) -> None:
        if self.failure is None:
            self.failure = (text, code)
        self.ended = True

    def ship(self, line: list[bytes]) -> None:
        if self.ask:
            # GNU shows the line it would prompt for, then cannot read
            # the answer.
            self.stop(_trace(line)[:-1] + _NO_TTY)
        elif self.reopen:
            shown = _trace(line) if self.traced else ""
            self.stop(shown + _tty_abort(line[0]), 125)
        else:
            self.out.append(line)
            self.waiting = True

    def begin(self) -> None:
        # Most collectors check nothing before the input.
        pass

    def word_room(self) -> int:
        """The most bytes one word may hold; a longer one is ``argument
        line too long``, which GNU 4.10 reports at the first byte past it,
        reading no further (with `echo` it stops 131067 bytes into a
        longer word)."""
        raise NotImplementedError

    def word(self, word: bytes) -> None:
        raise NotImplementedError

    def line_done(self) -> None:
        # Only -L counts lines.
        pass

    def fail(self, text: str) -> None:
        self.stop(text)

    def close(self) -> None:
        self.ended = True


class _Packer(_Collector):
    """Packs words after the initial arguments, as many as -s, -n and -L
    allow.

    With -x, or -L, a command may not be cut short: a word that does not
    fit is ``argument list too long`` (with -x only when -n asks for a
    count), and an error drops the words gathered so far, which otherwise
    run before xargs stops. A word too long for any command line is
    ``argument line too long``. Without -r, input with no words still runs
    the command once.

    Args:
        base (list[bytes]): the command name and its initial arguments.
        width (int): the -s limit.
        flags (set[str]): the toggles given.
        group (int): -n, words per command; 0 has no count.
        lines (int): -L, input lines per command; 0 has no count.
        most_words (int): the most words one command line holds.
    """

    def __init__(
        self,
        base: list[bytes],
        width: int,
        flags: set[str],
        *,
        group: int,
        lines: int,
        most_words: int,
    ) -> None:
        super().__init__(base, width, flags)
        self.group = group
        self.lines = lines
        self.most_words = most_words
        self.strict = "x" in flags
        self.whole = self.strict or lines > 0
        self.run_empty = "r" not in flags
        self.fixed = sum(len(word) + 1 for word in base)
        self.held: list[bytes] = []
        self.held_bytes = 0
        self.lines_held = 0
        self.shipped = False

    def begin(self) -> None:
        if self.fixed > self.width:
            self.stop(_NO_ROOM)

    def flush(self) -> None:
        line = self.base + [_before_nul(word) for word in self.held]
        self.held, self.held_bytes, self.lines_held = [], 0, 0
        self.shipped = True
        self.ship(line)

    def word_room(self) -> int:
        return self.width - self.fixed - 1

    def word(self, word: bytes) -> None:
        size = len(word) + 1
        if len(word) > self.word_room():
            # A word with bytes is stopped while it is read; only an empty
            # one gets here, when -s leaves no room after the command.
            self.fail(_LINE_TOO_LONG if word else _NO_ROOM)
            return
        if self.held and (
            self.fixed + self.held_bytes + size > self.width
            or len(self.base) + len(self.held) >= self.most_words
        ):
            if self.lines or (self.strict and self.group):
                self.stop(_LIST_TOO_LONG)
                return
            self.flush()
            if self.halted():
                return
        self.held.append(word)
        self.held_bytes += size
        if self.group and len(self.held) == self.group:
            self.flush()

    def line_done(self) -> None:
        if self.lines and self.held:
            self.lines_held += 1
            if self.lines_held == self.lines:
                self.flush()

    def fail(self, text: str) -> None:
        if self.held and not self.whole:
            self.flush()
        self.stop(text)

    def close(self) -> None:
        if self.held or (self.run_empty and not self.shipped):
            self.flush()
        self.ended = True


class _Filler(_Collector):
    """Runs the command once per -I line, the line put in place of every
    occurrence of the string in each initial argument (not the name).

    Measured on GNU 4.10: the first line must fit -s on its own and every
    later one beside the command name, else ``argument line too long``;
    the name must fit (``cannot fit single argument``); an argument whose
    filled-in text, with two bytes more, exceeds -s is ``command too
    long``, as is any initial argument when the string is empty; and the
    whole line must fit, else ``argument list too long``.

    Args:
        base (list[bytes]): the command name and its initial arguments.
        width (int): the -s limit.
        flags (set[str]): the toggles given.
        template (bytes): the string -I replaces.
    """

    def __init__(
        self, base: list[bytes], width: int, flags: set[str], template: bytes
    ) -> None:
        super().__init__(base, width, flags)
        self.template = template
        self.later = False

    def word_room(self) -> int:
        taken = len(self.base[0]) + 1 if self.later else 0
        return self.width - taken - 1

    def word(self, word: bytes) -> None:
        name = self.base[0]
        # The limit is met while bytes arrive, so an empty line passes
        # (GNU 4.10 runs `-I{} -s 5 echo` on a later empty line).
        if word and len(word) > self.word_room():
            self.stop(_LINE_TOO_LONG)
            return
        self.later = True
        if len(name) + 1 > self.width:
            self.stop(_NO_ROOM)
            return
        used = len(name) + 1
        line = [name]
        for part in self.base[1:]:
            if not self.template:
                self.stop(_TEMPLATE_TOO_LONG)
                return
            # The filled-in size is counted before the text is built, so
            # a long line in a long template costs no more than -s.
            found = part.count(self.template)
            size = len(part) + found * (len(word) - len(self.template))
            if size + 2 > self.width:
                self.stop(_TEMPLATE_TOO_LONG)
                return
            used += size + 1
            if used > self.width:
                self.stop(_LIST_TOO_LONG)
                return
            line.append(_before_nul(self.fill(part, word)))
        self.ship(line)

    def fill(self, part: bytes, word: bytes) -> bytes:
        # Each occurrence, left to right, never overlapping: GNU 4.10
        # turns `aaa` into `Za` for `-I aa`.
        return part.replace(self.template, word)


class _QuotedReader:
    """Splits input into words the way xargs does without -0 or -d.

    Blanks and newlines separate words; '...' and "..." keep blanks and
    take no escapes; a backslash outside them takes the next byte as it
    is, a newline included. A newline inside quotes is an unmatched quote;
    so is the end of input inside them, but only once the word holds a
    byte: GNU 4.10 runs nothing and exits 0 on a lone `'`. A word cut off
    by the end of input is dropped when it holds no byte.

    A line that ends in a blank goes on into the next one, which -L counts
    with it, and so does a line with no word on it (GNU 4.10 runs `a b`
    once for `a <newline><newline>b` with -L1). The -E word ends the input
    wherever a blank or newline closes it, but cut off by the end of input
    only as the first word of its line (GNU 4.10 stops at `a<newline>STOP`
    and passes `a STOP` on). With -I a whole line is one word: blanks
    inside it stay, leading ones go.

    Args:
        sink (_Collector): where words go.
        end_word (bytes | None): the -E string.
        whole_lines (bool): -I.
    """

    def __init__(
        self, sink: _Collector, end_word: bytes | None, whole_lines: bool
    ) -> None:
        self.sink = sink
        self.end_word = end_word
        self.whole_lines = whole_lines
        self.word = bytearray()
        self.begun = False
        self.quote: int | None = None
        self.escaped = False
        self.previous = -1
        self.line_open = False
        self.word_on_line = False
        self.warned = False

    def keep(self, byte: int) -> None:
        if byte == 0 and not self.warned:
            self.warned = True
            self.sink.note(_NUL_IN_INPUT)
        self.word.append(byte)
        self.begun = True
        self.check_room()

    def check_room(self) -> None:
        if len(self.word) > self.sink.word_room():
            self.sink.fail(_LINE_TOO_LONG)

    def feed(self, data: bytes, at: int = 0) -> int:
        """Reads from `at` until the data runs out, xargs stops, or a
        command is built; returns where it stopped.

        Args:
            data (bytes): one chunk of input.
            at (int): where to resume in it.
        """
        size = len(data)
        sink = self.sink
        while at < size and not sink.halted() and not sink.holding():
            if self.escaped:
                self.escaped = False
                self.previous = data[at]
                self.keep(data[at])
                at += 1
                continue
            if self.quote is not None:
                after = self.copy_run(data, at, _QUOTED_RUN[self.quote])
                if after > at:
                    at = after
                    continue
                byte = data[at]
                at += 1
                self.previous = byte
                if byte == self.quote:
                    self.quote = None
                elif byte == 0x0A:
                    sink.fail(_unclosed(self.quote))
                else:
                    self.keep(byte)
                continue
            if not self.begun and data[at] in _SKIPPED_BEFORE_WORD:
                at += 1
                continue
            run = _LINE_RUN if self.whole_lines and self.begun else _WORD_RUN
            after = self.copy_run(data, at, run)
            if after > at:
                self.begun = True
                at = after
                continue
            byte = data[at]
            at += 1
            if byte == 0x5C:
                self.escaped = True
            elif byte in (0x27, 0x22):
                self.quote = byte
                self.begun = True
            elif byte == 0x0A:
                carried = not self.whole_lines and self.previous in (
                    0x20,
                    0x09,
                )
                if self.begun:
                    self.finish_word(cut_off=False)
                ends = not carried and self.word_on_line
                self.word_on_line = False
                if ends and not sink.halted():
                    self.line_open = False
                    sink.line_done()
            elif byte in (0x20, 0x09):
                if self.begun and not self.whole_lines:
                    self.finish_word(cut_off=False)
            else:
                self.keep(byte)
            self.previous = byte
        return at

    def copy_run(self, data: bytes, at: int, run: re.Pattern[bytes]) -> int:
        # Copies the bytes from `at` that need no decision, but no more
        # than one past what the word may hold; returns where the next
        # one starts.
        most = max(1, self.sink.word_room() - len(self.word) + 1)
        found = run.match(data, at, at + most)
        if found is None:
            return at
        self.word += found.group()
        self.previous = data[found.end() - 1]
        self.check_room()
        return found.end()

    def finish_word(self, cut_off: bool) -> None:
        word = bytes(self.word)
        self.word.clear()
        self.begun = False
        if self.end_word is not None and not (cut_off and self.line_open):
            if _before_nul(word) == self.end_word:
                self.sink.close()
                return
        self.line_open = self.word_on_line = True
        self.sink.word(word)

    def end(self) -> bool:
        """Finishes the input; False when it paused with a command built
        from the last word, to be called again once that has been run."""
        sink = self.sink
        if sink.halted():
            return True
        if self.word:
            if self.quote is not None:
                sink.fail(_unclosed(self.quote))
                return True
            self.finish_word(cut_off=True)
            if sink.holding() and not sink.halted():
                return False
        if not sink.halted():
            sink.close()
        return True


class _SplitReader:
    """Splits input at one byte (-0, -d): every piece is a word as it
    stands, an empty one included, and counts as a line for -L; a last
    piece with no separator after it is a word too when it holds a byte.

    Args:
        sink (_Collector): where words go.
        separator (int): the byte.
    """

    def __init__(self, sink: _Collector, separator: int) -> None:
        self.sink = sink
        self.separator = bytes([separator])
        self.piece = bytearray()

    def feed(self, data: bytes, at: int = 0) -> int:
        """Reads from `at` until the data runs out, xargs stops, or a
        command is built; returns where it stopped.

        Args:
            data (bytes): one chunk of input.
            at (int): where to resume in it.
        """
        while not self.sink.halted() and not self.sink.holding():
            cut = data.find(self.separator, at)
            if not self.take(data, at, len(data) if cut < 0 else cut):
                return len(data)
            if cut < 0:
                return len(data)
            at = cut + 1
            self.hand_over()
        return at

    def take(self, data: bytes, start: int, stop: int) -> bool:
        # Copies no more than one byte past what the word may hold, so an
        # item that never ends stops at the limit.
        room = self.sink.word_room()
        most = max(1, room - len(self.piece) + 1)
        self.piece += data[start : min(stop, start + most)]
        if self.piece and len(self.piece) > room:
            self.sink.fail(_LINE_TOO_LONG)
            return False
        return True

    def hand_over(self) -> None:
        word = bytes(self.piece)
        self.piece.clear()
        self.sink.word(word)
        if not self.sink.halted():
            self.sink.line_done()

    def end(self) -> bool:
        """Finishes the input; False when it paused with a command built
        from the last piece, to be called again once that has been run."""
        if self.piece and not self.sink.halted():
            self.hand_over()
            if self.sink.holding() and not self.sink.halted():
                return False
        if not self.sink.halted():
            self.sink.close()
        return True


def _assemble(
    plan: _Plan, base: list[bytes], room: int
) -> tuple[_Collector, _QuotedReader | _SplitReader]:
    if plan.template is not None:
        sink: _Collector = _Filler(
            base, plan.width, plan.flags, encode_text(plan.template)
        )
    else:
        sink = _Packer(
            base,
            plan.width,
            plan.flags,
            group=plan.group,
            lines=plan.lines,
            # GNU 4.10 tries at most room / 8 - 2 words in one line (with
            # -s 2095097 and 300000 empty -0 items it tries 261885, then
            # halves what exec refuses; that retry is not modelled).
            most_words=room // 8 - 2,
        )
    if plan.separator is not None:
        return sink, _SplitReader(sink, plan.separator)
    end_word = (
        encode_text(plan.end_word) if plan.end_word is not None else None
    )
    return sink, _QuotedReader(sink, end_word, plan.template is not None)


def _trace(line: list[bytes]) -> str:
    return " ".join(shell_quote(decode_text(word)) for word in line) + "\n"


def xargs_missing(name: str) -> str:
    """GNU's report of a command xargs finds nothing to run for.

    Args:
        name (str): the command word.
    """
    return f"xargs: {name}: No such file or directory\n"


async def _drain_child(
    child: Awaitable[IOResult], output: IOResult, pipe: PipeConsole
) -> None:
    """Run one command into its pipe, keeping its stderr and status when
    cut short; one cut short before answering died of SIGPIPE.

    Args:
        child (Awaitable[IOResult]): the command's evaluation.
        output (IOResult): the run's result.
        pipe (PipeConsole): where the command writes.
    """
    io: IOResult | None = None
    try:
        io = await child
        await pump(pipe, Channel.STDERR, io.stderr)
        await pump(pipe, Channel.STDOUT, io.stdout)
    finally:
        output.stderr = await pipe.snapshot(Channel.STDERR)
        output.exit_code = SIGPIPE_STATUS if io is None else io.exit_code


async def _run_lines(
    execute_fn: Callable[..., Any],
    events: AsyncGenerator[str | list[bytes], None],
    context: EvaluationContext,
    procs: int,
    *,
    trace: bool = False,
    slot_var: str | None = None,
    registry: MountRegistry | None = None,
    stdin: ByteSource | None = None,
    torn: list[IOResult],
) -> AsyncGenerator[tuple[list[IOResult], int | None], None]:
    """Run the builder's command lines as they arrive, at most ``procs`` at
    a time.

    Messages keep their place among the runs. A command nobody provides
    stops xargs with GNU's 127 before it runs, and one exiting 255 stops
    it with 124 once it has run, each after GNU's diagnostic; the
    commands already running finish. Parallel mode, and a slot variable,
    give every command a fork of the session, so one cannot see
    another's variables, and each drains inside its fork, since a stream
    can still read the ambient session. Each event's results come back
    in input order, which is the order their output is written in, with
    the stop status so far.

    Args:
        execute_fn (Callable): shell evaluator for each line.
        events (AsyncGenerator[str | list[bytes], None]): messages and
            command lines, pulled only while a slot is free.
        context (EvaluationContext): the session the lines run in.
        procs (int): the -P count; 0 runs every line at once.
        trace (bool): -t, print each command line before it runs.
        slot_var (str | None): --process-slot-var, the variable that
            carries each command's slot number.
        registry (MountRegistry | None): where a command name is looked
            up; None runs every name.
        stdin (ByteSource | None): input shared by all commands (-a).
        torn (list[IOResult]): filled at teardown with the runs still
            going, for the caller to record.
    """
    session = context.session
    stop: int | None = None
    stopping = asyncio.Event()
    forked = procs != 1 or slot_var is not None
    taken: set[int] = set()
    feed = SharedStdin(stdin) if stdin is not None else b""

    active: dict[asyncio.Task[None], tuple[IOResult, PipeConsole]] = {}

    async def run(
        words: list[str], output: IOResult, pipe: PipeConsole
    ) -> None:
        line = shell_join(words)
        extra = {"session_id": session.session_id, "stdin": feed, "sink": pipe}
        # xargs execs its command, so a builtin that is also a program
        # answers as the program.
        if not forked:
            marked = set_program_invocation(session)
            try:
                await _drain_child(execute_fn(line, **extra), output, pipe)
            finally:
                reset_program_invocation(marked)
            return
        slot = next(n for n in range(len(taken) + 1) if n not in taken)
        taken.add(slot)
        child_evaluation = context.fork()
        child = child_evaluation.session
        if slot_var is not None:
            child.vars = {**child.vars, **vars_from_env({slot_var: str(slot)})}
        token = set_current_evaluation(child_evaluation)
        marked = set_program_invocation(child)
        try:
            await _drain_child(execute_fn(line, **extra), output, pipe)
        finally:
            reset_program_invocation(marked)
            reset_current_session(token)
            taken.discard(slot)

    async def invoke(
        event: str | list[bytes],
    ) -> tuple[list[IOResult], asyncio.Task[None] | None]:
        nonlocal stop
        results: list[IOResult] = []
        if isinstance(event, str):
            return [IOResult(stderr=encode_text(event))], None
        words = [decode_text(word) for word in event]
        if trace:
            results.append(IOResult(stderr=encode_text(_trace(event))))
        if registry is not None and not execs(words[0], session, registry):
            results.append(
                IOResult(
                    stderr=encode_text(xargs_missing(words[0])),
                    exit_code=NOT_FOUND_STATUS,
                )
            )
            stop = NOT_FOUND_STATUS
            stopping.set()
            return results, None
        pipe = PipeConsole()
        io = IOResult(stdout=pipe.stream())
        results.append(io)

        async def produce() -> None:
            nonlocal stop
            try:
                await run(words, io, pipe)
                if io.exit_code == 255 and stop is None:
                    aborted = f"xargs: {words[0]}: exited with status 255; aborting\n"
                    combined = await io.merge(
                        IOResult(stderr=encode_text(aborted))
                    )
                    io.stderr = combined.stderr
                    stop = TIMEOUT_STATUS
                    stopping.set()
            except BaseException as exc:
                stop = 1 if stop is None else stop
                pipe.end(exc)
                raise
            finally:
                pipe.end()

        task = asyncio.create_task(produce())
        active[task] = io, pipe
        return results, task

    async def admitted() -> AsyncIterator[str | list[bytes]]:
        stopped = asyncio.create_task(stopping.wait())
        pull: asyncio.Future[str | list[bytes]] | None = None
        try:
            while stop is None:
                pull = asyncio.ensure_future(anext(events))
                await asyncio.wait(
                    {pull, stopped}, return_when=asyncio.FIRST_COMPLETED
                )
                if stopped.done():
                    return
                try:
                    yield pull.result()
                except StopAsyncIteration:
                    return
        finally:
            stopped.cancel()
            if pull is not None:
                pull.cancel()
            await asyncio.gather(
                stopped,
                *([pull] if pull is not None else []),
                return_exceptions=True,
            )

    mapped = bounded_map_stream(admitted(), invoke, procs)
    try:
        async for results, task in mapped:
            yield results, stop
            if task is not None:
                await task
                del active[task]
    finally:
        await mapped.aclose()
        for _, pipe in active.values():
            pipe.close_reader()
        for task in active:
            task.cancel()
        for outcome in await asyncio.gather(*active, return_exceptions=True):
            if isinstance(outcome, Exception) and not isinstance(
                outcome, PipeClosed
            ):
                logger.debug("xargs command raised at teardown: %r", outcome)
        torn.extend(io for io, _ in active.values())
        await events.aclose()


async def handle_xargs(
    execute_fn: Callable[..., Any],
    args: list[str],
    context: EvaluationContext,
    stdin: ByteSource | None,
    *,
    dispatch: DispatchFn | None = None,
    registry: MountRegistry | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a command with words read from stdin (GNU xargs).

    The words are appended to the initial arguments, or with -I each
    input line takes the place of the string in them. Options act in
    the order given: -I, -L and -n cancel each other with GNU's warning,
    and --help or --version answers where it stands. The spec declares
    every option GNU's table has, so an abbreviated long option
    resolves exactly as GNU's does.

    The limits are GNU's on a Linux system with an 8 MiB stack: the
    environment counts against ARG_MAX (2 MiB) as GNU measures it, and
    a command line holds 128 KiB unless -s says otherwise. There is no
    terminal, so -p and -o fail the way GNU does without one.

    GNU xargs execs the command directly, so every input word must
    reach it as exactly one argv token. The inner line is built with
    shell_join: a plain join would be re-parsed by the shell, splitting
    words with whitespace and executing $(...) found in input.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): options, then command name and initial
            arguments; the command defaults to ["echo"] like GNU.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): input whose words become arguments.
        dispatch (DispatchFn | None): op dispatcher, which reads -a.
        registry (MountRegistry | None): where command names are looked
            up; None runs every name.
    """
    session = context.session
    parse = parse_shell_options(SHELL_SPECS["xargs"], args or [])
    environment = sum(
        len(encode_text(f"{name}={value}")) + 1
        for name, value in env_snapshot(session).items()
    )
    room = _EXEC_BYTES - environment - _UNUSED_BYTES
    plan = _Plan(room=room, crowded=_UNUSED_BYTES + environment >= _EXEC_BYTES)
    plan.width = min(_STANDARD_WIDTH, room)
    try:
        for name, value in parse.given:
            if name in ("help", "version"):
                return _answer(name, plan.notes)
            plan.take(name, value if isinstance(value, str) else None)
    except UsageError as refused:
        return _refusal(plan.notes + str(refused), refused.exit_code)
    notes = encode_text(plan.notes)
    if parse.invalid is not None:
        stderr, code = (
            ambiguous_option_error("xargs", parse.invalid, parse.candidates)
            if parse.candidates
            else unknown_option_error("xargs", parse.invalid)
        )
        return _refusal(notes + stderr, code)
    if parse.unexpected_value is not None:
        stderr, code = unexpected_value_error("xargs", parse.unexpected_value)
        return _refusal(notes + stderr, code)
    if parse.needs_value is not None:
        stderr, code = missing_value_error("xargs", parse.needs_value)
        return _refusal(notes + stderr, code)
    if plan.end_word is not None and plan.separator is not None:
        plan.notes += (
            "xargs: warning: the -E option has no effect if -0 or -d "
            "is used.\n\n"
        )
    if plan.crowded:
        return _refusal(plan.notes + _CROWDED)

    child_stdin: ByteSource | None = None
    if plan.source == "-":
        data = stdin if stdin is not None else b""
    else:
        try:
            if dispatch is None:
                raise enoent(plan.source)
            data = await read_script_bytes(dispatch, plan.source, session.cwd)
        except FS_ERRORS as exc:
            return _refusal(
                plan.notes + "xargs: Cannot open input file "
                f"'{quote_text(plan.source)}': {fs_strerror(exc)}\n"
            )
        child_stdin = stdin
    if "show-limits" in plan.flags:
        plan.notes += _limits_report(environment, room, plan.width)

    base = [encode_text(word) for word in parse.operands or ["echo"]]
    sink, reader = _assemble(plan, base, room)

    async def events() -> AsyncGenerator[str | list[bytes], None]:
        source = chunks(data)
        try:
            sink.begin()
            while not sink.halted():
                chunk = await anext(source, None)
                # Each command goes to the runner as soon as it is built,
                # before the rest of the chunk is read.
                if chunk is None:
                    finished = False
                    while not finished:
                        finished = reader.end()
                        for event in sink.drain():
                            yield event
                    break
                at = 0
                while True:
                    at = reader.feed(chunk, at)
                    for event in sink.drain():
                        yield event
                    if at >= len(chunk) or sink.halted():
                        break
        finally:
            await source.aclose()

    merged = IOResult(stderr=encode_text(plan.notes) or None)
    node = ExecutionNode(command="xargs")

    async def output() -> AsyncIterator[bytes]:
        stop = None
        failed = False
        torn: list[IOResult] = []

        async def record(io: IOResult) -> None:
            nonlocal failed, stop
            failed = failed or io.exit_code != 0
            if io.exit_code == 255 and stop is None:
                stop = TIMEOUT_STATUS
            combined = await merged.merge(IOResult(stderr=io.stderr))
            merged.stderr = combined.stderr

        results = _run_lines(
            execute_fn,
            events(),
            context,
            plan.jobs,
            trace="t" in plan.flags,
            slot_var=plan.slot_var,
            registry=registry,
            stdin=child_stdin,
            torn=torn,
        )
        try:
            async for ios, stop in results:
                for io in ios:
                    async with aclosing(chunks(io.stdout or b"")) as source:
                        async for chunk in source:
                            yield chunk
                    await record(io)
        finally:
            await results.aclose()
            for io in torn:
                await record(io)
            # A reader that stops early still sees the runs it reached.
            if stop is not None:
                merged.exit_code = stop
            elif sink.failure is not None:
                text, code = sink.failure
                combined = await merged.merge(
                    IOResult(stderr=encode_text(text))
                )
                merged.stderr = combined.stderr
                # A command that failed outranks xargs's own error: GNU
                # 4.10 exits 123 on `X1 'c` when X1 fails.
                merged.exit_code = 123 if failed else code
            else:
                merged.exit_code = 123 if failed else 0
            node.exit_code = merged.exit_code

    return output(), merged, node


async def xargs_builtin(call: BuiltinCall) -> Result:
    """The ``xargs`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_xargs(
        call.execute_fn,
        list(call.argv.args),
        call.context,
        call.stdin,
        dispatch=call.dispatch,
        registry=call.registry,
    )
