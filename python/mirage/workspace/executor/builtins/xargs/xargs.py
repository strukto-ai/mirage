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
import re
from collections.abc import AsyncGenerator, AsyncIterator, Callable, Generator
from contextlib import aclosing
from typing import Any

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
from mirage.io.stream import SharedStdin, yield_bytes
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.console.pipe import PipeConsole
from mirage.shell.console.types import Channel
from mirage.shell.join import shell_join
from mirage.utils.quote import shell_quote
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.script.script import read_script_bytes
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup.lookup import execs
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.session.session import vars_from_env
from mirage.workspace.session.state import env_snapshot
from mirage.workspace.types import ExecutionNode

_SYNOPSIS = "xargs [OPTION]... COMMAND [INITIAL-ARGS]..."
_PROCS_MAX = 2147483647
_ARG_MAX = 2097152
_HEADROOM = 2048
_POSIX_ARG_MIN = 4096
_DEFAULT_ARG_SIZE = 131072
_BLANKS = frozenset(b" \t")
_SPACES = frozenset(b" \t\n\v\f\r")
_QUOTES = {ord("'"): "single", ord('"'): "double"}
_NUMBER = re.compile(r"[ \t\n\v\f\r]*[+-]?[0-9]+")
_ESCAPES = {
    "a": 7,
    "b": 8,
    "f": 12,
    "n": 10,
    "r": 13,
    "t": 9,
    "v": 11,
    "\\": 92,
}
_NUL_WARNING = (
    "xargs: WARNING: a NUL character occurred in the input.  "
    "It cannot be passed through in the argument list.  "
    "Did you mean to use the --null option?\n"
)
_NORM, _SPACE, _QUOTE, _BACKSLASH = range(4)


class _Fatal(Exception):
    """GNU's ``error (EXIT_FAILURE, ...)``: the message ends xargs.

    Args:
        message (str): the diagnostic, newline included.
        code (int): the exit status.
    """

    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


def _refuse(
    stderr: str | bytes, exit_code: int = 1
) -> tuple[None, IOResult, ExecutionNode]:
    data = encode_text(stderr) if isinstance(stderr, str) else stderr
    return (
        None,
        IOResult(exit_code=exit_code, stderr=data),
        ExecutionNode(command="xargs", exit_code=exit_code),
    )


def _count_error(
    raw: str, name: str, least: int = 1, most: int | None = None
) -> str | None:
    """GNU's parse_num refusal of a count, None for a valid one.

    Args:
        raw (str): the option's value as typed.
        name (str): the option letter.
        least (int): the smallest count the option takes.
        most (int | None): the largest, None when unbounded.
    """
    if not _NUMBER.fullmatch(raw):
        message = f'invalid number "{raw}" for -{name} option'
    elif int(raw) < least:
        message = f"value {raw} for -{name} option should be >= {least}"
    elif most is not None and int(raw) > most:
        message = f"value {raw} for -{name} option should be <= {most}"
    else:
        return None
    return f"xargs: {message}\n{usage_hint('xargs')}\n"


def _standard_response(
    option: str, warnings: str
) -> tuple[ByteSource, IOResult, ExecutionNode]:
    """xargs's answer to --help or --version: stdout, exit 0.

    Args:
        option (str): "help" or "version".
        warnings (str): the option warnings printed before it.
    """
    text = (
        encode_text(
            render_help("xargs", SHELL_SPECS["xargs"], synopsis=_SYNOPSIS)
        )
        if option == "help"
        else version_line("xargs")
    )
    return (
        yield_bytes(text),
        IOResult(stderr=encode_text(warnings) or None),
        ExecutionNode(command="xargs", exit_code=0),
    )


def _exclusive(option: str, offending: str) -> str:
    return (
        f"xargs: warning: options {offending} and {option} are mutually "
        f"exclusive, ignoring previous {offending} value\n"
    )


def _delimiter(spec: str) -> tuple[int, str]:
    """GNU's get_input_delimiter: the byte, or its refusal.

    One byte stands for itself; otherwise the value is a C escape (a
    letter, ``\\`` or an octal or ``\\x`` hex code) and anything else is
    refused, the empty value included.

    Args:
        spec (str): the -d value as typed.
    """
    raw = encode_text(spec)
    if len(raw) == 1:
        return raw[0], ""
    if not spec.startswith("\\"):
        return 0, (
            f"xargs: Invalid input delimiter specification {spec}: "
            "the delimiter must be either a single character or an "
            "escape sequence starting with \\.\n"
        )
    named = _ESCAPES.get(spec[1])
    if named is not None:
        return named, ""
    if spec[1] != "x" and not spec[1].isdigit():
        return 0, (
            f"xargs: Invalid escape sequence {spec} in input "
            "delimiter specification.\n"
        )
    base, body = (16, spec[2:]) if spec[1] == "x" else (8, spec[1:])
    match = re.match(r"[0-9a-fA-F]*" if base == 16 else r"[0-7]*", body)
    digits = match.group(0) if match else ""
    value = int(digits, base) if digits else 0
    if value > 255:
        return 0, (
            f"xargs: Invalid escape sequence {spec} in input "
            "delimiter specification; character values must not "
            f"exceed {'ff' if base == 16 else '377'}.\n"
        )
    tail = body[len(digits) :]
    if tail:
        return 0, (
            f"xargs: Invalid escape sequence {spec} in input "
            f"delimiter specification; trailing characters {tail} "
            "not recognised.\n"
        )
    return value, ""


def _unmatched(quote: int) -> str:
    return (
        f"xargs: unmatched {_QUOTES[quote]} quote; by default quotes are "
        "special to xargs unless you use the -0 option\n"
    )


def _c_string(word: bytes) -> bytes:
    return word.split(b"\0", 1)[0]


def _limits(env_size: int, posix_max: int, arg_max: int) -> str:
    return (
        f"Your environment variables take up {env_size} bytes\n"
        "POSIX upper limit on argument length (this system): "
        f"{posix_max}\n"
        "POSIX smallest allowable upper limit on argument length "
        f"(all systems): {_POSIX_ARG_MIN}\n"
        "Maximum length of command we could actually use: "
        f"{posix_max - env_size}\n"
        f"Size of command buffer we are actually using: {arg_max}\n"
        "Maximum parallelism (--max-procs must be no greater): "
        f"{_PROCS_MAX}\n"
    )


class _Builder:
    """GNU xargs's input reader and command builder over one input.

    A port of ``read_line``, ``read_string`` and buildcmd.c: words are
    pushed onto the pending command line until a -n, -L or size limit
    runs it, and every limit, logical EOF and refusal lands where GNU's
    does. ``events`` records what GNU does in order, a message (str) or
    a command line to run (list[bytes]); a refusal raises ``_Fatal``
    after the events before it.

    Args:
        data (bytes): the initial input chunk.
        command (list[bytes]): the command and its initial arguments.
        delim (int | None): the -0/-d delimiter byte, None for lines.
        eof (bytes | None): the logical end-of-file word.
        replace (bytes | None): the -I string.
        max_args (int): the -n count, 0 when unset.
        max_lines (int): the -L count, 0 when unset.
        arg_max (int): the command line size limit (-s).
        max_argc (int): the most arguments a command line takes.
        exit_if_exceeded (bool): -x, which -I and -L imply.
        always_run (bool): run once on empty input (no -r).
        query (bool): -p, which needs a terminal to ask on.
        open_tty (bool): -o, which needs a terminal for the command.
    """

    def __init__(
        self,
        data: bytes,
        command: list[bytes],
        *,
        delim: int | None,
        eof: bytes | None,
        replace: bytes | None,
        max_args: int,
        max_lines: int,
        arg_max: int,
        max_argc: int,
        exit_if_exceeded: bool,
        always_run: bool,
        query: bool,
        open_tty: bool,
    ) -> None:
        self.data = data
        self.pos = 0
        self.command = command
        self.delim = delim
        self.eof_word = eof
        self.replace = replace
        self.max_args = max_args
        self.max_lines = max_lines
        self.arg_max = arg_max
        self.max_argc = max_argc
        self.exit_if_exceeded = (
            exit_if_exceeded or replace is not None or max_lines > 0
        )
        self.always_run = always_run
        self.query = query
        self.open_tty = open_tty
        self.events: list[str | list[bytes]] = []
        self.args: list[bytes] = []
        self.chars = 0
        self.initial_chars = 0
        self.initial_argc = 0
        self.initial = True
        self.runs = 0
        self.lineno = 0
        self.eof = False
        self.nul_warned = False
        self.line = b""

    def build(self) -> Generator[str | list[bytes] | None, None, None]:
        """Yield commands/messages or None to request the next input chunk."""
        if self.replace is None:
            for word in self.command:
                self._push(word, len(word) + 1)
            self.initial = False
            self.initial_argc = len(self.args)
            self.initial_chars = self.chars
            while (yield from self._read()) != -1:
                if self.max_lines and self.lineno >= self.max_lines:
                    self._exec()
                    self.lineno = 0
            if len(self.args) != self.initial_argc or (
                self.always_run and not self.runs
            ):
                self._exec()
            return
        head, rest = self.command[0], self.command[1:]
        while (length := (yield from self._read())) != -1:
            line = _c_string(self.line)
            self.args, self.chars = [], 0
            self._push(head, len(head) + 1)
            self.initial = False
            for arg in rest:
                self._insert(arg, line, length - 1)
            self._exec()

    def _read(self) -> Generator[str | list[bytes] | None, None, int]:
        return (
            yield from (
                self._read_line() if self.delim is None else self._read_item()
            )
        )

    def _take(self, word: bytes) -> int:
        self.line = word
        if self.replace is None:
            self._push(_c_string(word), len(word) + 1)
        return len(word) + 1

    def _is_eof(self, word: bytes) -> bool:
        return self.eof_word is not None and _c_string(word) == self.eof_word

    def _read_char(self) -> Generator[str | list[bytes] | None, None, int]:
        if self.eof:
            return -1
        while self.events:
            yield self.events.pop(0)
        if self.pos >= len(self.data):
            yield None
        if self.pos >= len(self.data):
            self.eof = True
            return -1
        char = self.data[self.pos]
        self.pos += 1
        return char

    def _read_line(self) -> Generator[str | list[bytes] | None, None, int]:
        state, quote, c, first, seen = _SPACE, 0, -1, True, False
        buf = bytearray()
        room = self.arg_max - self.initial_chars - 1
        while True:
            prev = c
            c = yield from self._read_char()
            if c == -1:
                if not buf:
                    return -1
                if state == _QUOTE:
                    self._exec_if_possible()
                    raise _Fatal(_unmatched(quote))
                if first and self._is_eof(bytes(buf)):
                    return -1
                return self._take(bytes(buf))
            if state == _SPACE:
                if c in _SPACES:
                    continue
                state = _NORM
            if state == _NORM:
                if c == 10:
                    if prev not in _BLANKS:
                        self.lineno += 1
                    if not buf and not seen:
                        state = _SPACE
                        continue
                    if self._is_eof(bytes(buf)):
                        self.eof = True
                        return -1 if first else len(buf) + 1
                    return self._take(bytes(buf))
                seen = True
                if self.replace is None and c in _BLANKS:
                    if self._is_eof(bytes(buf)):
                        self.eof = True
                        return -1 if first else len(buf) + 1
                    self._take(bytes(buf))
                    buf, state, first = bytearray(), _SPACE, False
                    continue
                if c == 92:
                    state = _BACKSLASH
                    continue
                if c in _QUOTES:
                    state, quote = _QUOTE, c
                    continue
            elif state == _QUOTE:
                if c == 10:
                    self._exec_if_possible()
                    raise _Fatal(_unmatched(quote))
                if c == quote:
                    state, seen = _NORM, True
                    continue
            else:
                state = _NORM
            if c == 0 and not self.nul_warned:
                self.events.append(_NUL_WARNING)
                self.nul_warned = True
            if len(buf) >= room:
                self._exec_if_possible()
                raise _Fatal("xargs: argument line too long\n")
            buf.append(c)

    def _read_item(self) -> Generator[str | list[bytes] | None, None, int]:
        buf = bytearray()
        room = self.arg_max - self.initial_chars - 1
        while True:
            c = yield from self._read_char()
            if c == -1:
                return self._take(bytes(buf)) if buf else -1
            if c == self.delim:
                self.lineno += 1
                return self._take(bytes(buf))
            if len(buf) >= room:
                self._exec_if_possible()
                raise _Fatal("xargs: argument line too long\n")
            buf.append(c)

    def _full(self) -> bool:
        if (
            not self.initial
            and self.max_args
            and len(self.args) - self.initial_argc == self.max_args
        ):
            return True
        return len(self.args) == self.max_argc

    def _push(self, arg: bytes, length: int) -> None:
        if self.chars + length > self.arg_max:
            if self.initial or len(self.args) == self.initial_argc:
                raise _Fatal(
                    "xargs: cannot fit single argument within "
                    "argument list size limit\n"
                )
            if self.replace is not None or (
                self.exit_if_exceeded and (self.max_lines or self.max_args)
            ):
                raise _Fatal("xargs: argument list too long\n")
            self._exec()
        if self._full():
            self._exec()
        self.args.append(arg)
        self.chars += length
        if self._full():
            self._exec()
        if self.initial:
            self.initial_chars = self.chars

    def _insert(self, arg: bytes, line: bytes, size: int) -> None:
        """GNU's bc_do_insert: one initial argument with -I applied.

        Args:
            arg (bytes): the initial argument.
            line (bytes): the input line, cut at a NUL as C cuts it.
            size (int): the line's length as read, NULs included.
        """
        assert self.replace is not None
        room = self.arg_max - 1
        out = bytearray()
        once = True
        while once or arg:
            once = False
            at = arg.find(self.replace)
            span = at if at >= 0 else len(arg)
            if room <= span:
                break
            room -= span
            out += arg[:span]
            arg = arg[span:]
            if at < 0:
                continue
            if room <= size or not (self.replace or size):
                break
            room -= size
            out += line + b"\0" * (size - len(line))
            arg = arg[len(self.replace) :]
        if arg:
            raise _Fatal("xargs: command too long\n")
        self._push(_c_string(bytes(out)), len(out) + 1)

    def _exec_if_possible(self) -> None:
        if (
            self.replace is not None
            or self.initial
            or len(self.args) == self.initial_argc
            or self.exit_if_exceeded
        ):
            return
        self._exec()

    def _exec(self) -> None:
        line = list(self.args)
        if self.query:
            self.events.append(_trace(line)[:-1])
            raise _Fatal(
                "xargs: failed to open /dev/tty for reading: "
                "No such device or address\n"
            )
        if self.open_tty:
            name = decode_text(line[0])
            raise _Fatal(
                "xargs: '/dev/tty': No such device or address\n"
                "xargs: xargs.c:1648: wait_for_proc_all: Assertion "
                "`getpid () == parent' failed.\n"
                f"xargs: {name}: terminated by signal 6\n",
                125,
            )
        self.events.append(line)
        self.runs += 1
        del self.args[self.initial_argc :]
        self.chars = self.initial_chars


def _trace(line: list[bytes]) -> str:
    return " ".join(shell_quote(decode_text(word)) for word in line) + "\n"


def xargs_missing(name: str) -> str:
    """GNU's report of a command xargs finds nothing to run for.

    Args:
        name (str): the command word.
    """
    return f"xargs: {name}: No such file or directory\n"


async def _drain_child(
    io: IOResult, output: IOResult, pipe: PipeConsole
) -> None:
    async with aclosing(chunks(io.stdout or b"")) as source:
        async for chunk in source:
            await pipe.emit(Channel.STDOUT, chunk)
    await pipe.emit(Channel.STDERR, await io.materialize_stderr())
    output.stderr = await pipe.snapshot(Channel.STDERR)
    output.exit_code = io.exit_code


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
    """
    session = context.session
    stop: int | None = None
    stopping = asyncio.Event()
    forked = procs != 1 or slot_var is not None
    taken: set[int] = set()
    feed = SharedStdin(stdin) if stdin is not None else b""

    active: set[asyncio.Task[None]] = set()
    pipes: set[PipeConsole] = set()

    async def run(
        words: list[str], output: IOResult, pipe: PipeConsole
    ) -> None:
        line = shell_join(words)
        extra = {"stdin": feed, "sink": pipe}
        io: IOResult
        # xargs execs its command, so a builtin that is also a program
        # answers as the program.
        if not forked:
            marked = set_program_invocation(session)
            try:
                io = await execute_fn(
                    line, session_id=session.session_id, **extra
                )
                await _drain_child(io, output, pipe)
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
            io = await execute_fn(line, session_id=session.session_id, **extra)
            await _drain_child(io, output, pipe)
        finally:
            reset_program_invocation(marked)
            reset_current_session(token)
            taken.discard(slot)

    async def invoke(
        event: str | list[bytes],
    ) -> tuple[list[IOResult], asyncio.Task[None] | None, PipeConsole | None]:
        nonlocal stop
        results: list[IOResult] = []
        if isinstance(event, str):
            return [IOResult(stderr=encode_text(event))], None, None
        words = [decode_text(word) for word in event]
        if trace:
            results.append(IOResult(stderr=encode_text(_trace(event))))
        if registry is not None and not execs(words[0], session, registry):
            results.append(
                IOResult(
                    stderr=encode_text(xargs_missing(words[0])),
                    exit_code=127,
                )
            )
            stop = 127
            stopping.set()
            return results, None, None
        pipe = PipeConsole()
        pipes.add(pipe)
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
                    stop = 124
                    stopping.set()
            except BaseException as exc:
                stop = 1 if stop is None else stop
                pipe.end(exc)
                raise
            finally:
                pipe.end()

        task = asyncio.create_task(produce())
        active.add(task)
        return results, task, pipe

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
        async for results, task, pipe in mapped:
            yield results, stop
            if task is not None:
                await task
                active.remove(task)
            if pipe is not None:
                pipes.remove(pipe)
            if stop is not None:
                yield [], stop
    finally:
        await mapped.aclose()
        for pipe in pipes:
            pipe.close_reader()
        for task in active:
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
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
    the order given, as GNU's getopt loop reads them: -I, -L and -n
    cancel each other with GNU's warning, and --help or --version
    answers where it stands. The spec declares every option GNU's table
    has, so an abbreviated long option resolves exactly as GNU's does.

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
    env_size = sum(
        len(encode_text(f"{name}={value}")) + 1
        for name, value in env_snapshot(session).items()
    )
    posix_max = _ARG_MAX - env_size - _HEADROOM
    oversized = _HEADROOM + env_size >= _ARG_MAX
    arg_max = min(_DEFAULT_ARG_SIZE, posix_max)
    replace: str | None = None
    max_lines = 0
    max_args = 0
    procs = 1
    warnings = ""
    delim: int | None = None
    eof: str | None = None
    arg_file = "-"
    slot_var: str | None = None
    toggles: set[str] = set()
    for name, value in parse.given:
        if name in ("help", "version"):
            return _standard_response(name, warnings)
        if name == "0":
            delim = 0
        if name == "d" and isinstance(value, str):
            delim, refusal = _delimiter(value)
            if refusal:
                return _refuse(warnings + refusal)
        if name in ("E", "e"):
            eof = value if isinstance(value, str) and value else None
        if name in ("t", "p", "x", "o", "r", "show-limits"):
            toggles.add(name)
        if name == "a" and isinstance(value, str):
            arg_file = value
        if name == "process-slot-var" and isinstance(value, str):
            if "=" in value:
                return _refuse(
                    warnings + "xargs: option --process-slot-var "
                    "may not be set to a value which includes `='\n"
                )
            if not value:
                return _refuse(
                    warnings + "xargs: failed to unset environment "
                    "variable : Invalid argument\n"
                )
            slot_var = value
        if name == "s" and isinstance(value, str):
            if oversized:
                return _refuse(
                    warnings + "xargs: environment is too large for exec\n"
                )
            if not _NUMBER.fullmatch(value):
                return _refuse(
                    warnings + f'xargs: invalid number "{value}" '
                    f"for -s option\n{usage_hint('xargs')}\n"
                )
            arg_max = int(value)
            if arg_max < 1:
                warnings += (
                    f"xargs: value {value} for -s option should be >= 1\n"
                )
                arg_max = 1
            elif arg_max > posix_max:
                warnings += (
                    f"xargs: value {value} for -s option should be "
                    f"<= {posix_max}\n"
                )
                arg_max = posix_max
        if name in ("I", "i"):
            if max_args:
                warnings += _exclusive("--replace/-I/-i", "--max-args")
            if max_lines:
                warnings += _exclusive("--replace/-I/-i", "--max-lines")
            replace = value if isinstance(value, str) else "{}"
            max_lines, max_args = 0, 0
            continue
        if name not in ("L", "l", "n", "P"):
            continue
        raw = value if isinstance(value, str) else "1"
        least, most = (0, _PROCS_MAX) if name == "P" else (1, None)
        error = _count_error(raw, name, least, most)
        if error is not None:
            return _refuse(warnings + error)
        count = int(raw)
        if name == "P":
            procs = count
            continue
        if name in ("L", "l"):
            option = "-L" if name == "L" else "--max-lines/-l"
            if max_args:
                warnings += _exclusive(option, "--max-args")
            if replace is not None:
                warnings += _exclusive(option, "--replace")
            replace, max_lines, max_args = None, count, 0
            continue
        if max_lines:
            warnings += _exclusive("--max-args/-n", "--max-lines")
        max_lines = 0
        if replace is not None and count == 1:
            # GNU reads `-I {} -n1` as plain -I.
            continue
        if replace is not None:
            warnings += _exclusive("--max-args/-n", "--replace")
        replace, max_args = None, count
    if parse.invalid is not None:
        stderr, code = (
            ambiguous_option_error("xargs", parse.invalid, parse.candidates)
            if parse.candidates
            else unknown_option_error("xargs", parse.invalid)
        )
        return _refuse(encode_text(warnings) + stderr, code)
    if parse.unexpected_value is not None:
        stderr, code = unexpected_value_error("xargs", parse.unexpected_value)
        return _refuse(encode_text(warnings) + stderr, code)
    if parse.needs_value is not None:
        stderr, code = missing_value_error("xargs", parse.needs_value)
        return _refuse(encode_text(warnings) + stderr, code)
    if eof is not None and delim is not None:
        warnings += (
            "xargs: warning: the -E option has no effect if -0 or -d "
            "is used.\n\n"
        )
    if oversized:
        return _refuse(warnings + "xargs: environment is too large for exec\n")

    child_stdin: ByteSource | None = None
    if arg_file == "-":
        data = stdin if stdin is not None else b""
    else:
        try:
            if dispatch is None:
                raise enoent(arg_file)
            data = await read_script_bytes(dispatch, arg_file, session.cwd)
        except FS_ERRORS as exc:
            return _refuse(
                warnings + "xargs: Cannot open input file "
                f"'{quote_text(arg_file)}': {fs_strerror(exc)}\n"
            )
        child_stdin = stdin
    if "show-limits" in toggles:
        warnings += _limits(env_size, posix_max, arg_max)

    builder = _Builder(
        b"",
        [encode_text(word) for word in parse.operands or ["echo"]],
        delim=delim,
        eof=encode_text(eof) if eof is not None else None,
        replace=encode_text(replace) if replace is not None else None,
        max_args=max_args,
        max_lines=max_lines,
        arg_max=arg_max,
        max_argc=posix_max // 8 - 2,
        exit_if_exceeded="x" in toggles,
        always_run="r" not in toggles,
        query="p" in toggles,
        open_tty="o" in toggles,
    )
    fatal: _Fatal | None = None

    async def events() -> AsyncGenerator[str | list[bytes], None]:
        nonlocal fatal
        source = chunks(data)
        steps = builder.build()
        try:
            while True:
                try:
                    event = next(steps)
                except StopIteration:
                    break
                except _Fatal as caught:
                    fatal = caught
                    break
                if event is None:
                    builder.data = await anext(source, b"")
                    builder.pos = 0
                else:
                    yield event
            for event in builder.events:
                yield event
            builder.events.clear()
        finally:
            steps.close()
            await source.aclose()

    merged = IOResult(stderr=encode_text(warnings) or None)
    node = ExecutionNode(command="xargs")

    async def output() -> AsyncIterator[bytes]:
        stop = None
        failed = False
        pending: IOResult | None = None

        async def record(io: IOResult) -> None:
            nonlocal failed, stop
            failed = failed or io.exit_code != 0
            if io.exit_code == 255 and stop is None:
                stop = 124
            combined = await merged.merge(IOResult(stderr=io.stderr))
            merged.stderr = combined.stderr

        results = _run_lines(
            execute_fn,
            events(),
            context,
            procs,
            trace="t" in toggles,
            slot_var=slot_var,
            registry=registry,
            stdin=child_stdin,
        )
        try:
            async for ios, stop in results:
                for io in ios:
                    pending = io
                    async with aclosing(chunks(io.stdout or b"")) as source:
                        async for chunk in source:
                            yield chunk
                    await record(io)
                    pending = None
        finally:
            await results.aclose()
            if pending is not None:
                await record(pending)
            # A reader that stops early still sees the runs it reached.
            if stop is not None:
                merged.exit_code = stop
            elif fatal is not None:
                combined = await merged.merge(
                    IOResult(stderr=encode_text(fatal.message))
                )
                merged.stderr = combined.stderr
                merged.exit_code = fatal.code
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
