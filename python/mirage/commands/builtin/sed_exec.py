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
from collections.abc import AsyncGenerator, AsyncIterator, Mapping
from dataclasses import dataclass, field

from mirage.commands.builtin.sed_script import (
    SED_STDERR,
    SED_STDOUT,
    SedAddr,
    SedCommand,
    SedProgram,
    SedRegex,
    sed_regex_flags,
)
from mirage.commands.builtin.utils.stream import never_opened
from mirage.commands.spec.usage import read_fail_exit_code
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.render import fs_error_line
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource
from mirage.io.yield_budget import YieldBudget
from mirage.shell.bytes import byte_view, from_byte_view, text_view
from mirage.types import PathSpec
from mirage.utils.posix import compile_posix_regex

SED_LINE_LENGTH = 70

_LIST_ESCAPES = {
    0x07: "\\a",
    0x08: "\\b",
    0x0C: "\\f",
    0x0A: "\\n",
    0x0D: "\\r",
    0x09: "\\t",
    0x0B: "\\v",
}

_RANGE_INACTIVE = 0
_RANGE_ACTIVE = 1
_RANGE_CLOSED = 2


def list_line(text: str, width: int, utf8: bool = False) -> str:
    """Render a pattern space the way GNU's ``l`` (do_list) does.

    A printable ASCII byte is itself and a backslash is doubled; ``\\a \\b
    \\f \\n \\r \\t \\v`` are C escapes; every other byte, each byte of a
    multibyte character included and whatever the locale, is three octal
    digits. A line is folded with ``\\`` before an escape that would reach
    ``width`` columns, so 69 characters and the ``\\`` fill a 70-column
    line; ``width`` 0 turns folding off, and 1 folds before every
    character. The end is ``$``.

    Args:
        text (str): the pattern space.
        width (int): the line length.
        utf8 (bool): the pattern space is text under a UTF-8 locale.
    """
    out: list[str] = []
    col = 0
    for ch in text:
        for byte in from_byte_view(ch, utf8):
            if 0x20 <= byte < 0x7F:
                piece = "\\\\" if byte == 0x5C else chr(byte)
            else:
                piece = _LIST_ESCAPES.get(byte, f"\\{byte:03o}")
            if width > 0 and col + len(piece) >= width:
                out.append("\\\n")
                col = 0
            out.append(piece)
            col += len(piece)
    out.append("$\n")
    return "".join(out)


@dataclass
class SedOutput:
    """One output stream and whether its last line lacked a newline."""

    chunks: list[str] = field(default_factory=list)
    missing_newline: bool = False

    def flush_newline(self) -> None:
        """GNU's output_missing_newline.

        A line written without its newline gets it the moment anything
        else goes to the same stream.
        """
        if self.missing_newline:
            self.chunks.append("\n")
            self.missing_newline = False

    def line(self, text: str, newline: bool) -> None:
        self.flush_newline()
        self.chunks.append(text)
        if newline:
            self.chunks.append("\n")
        else:
            self.missing_newline = True

    def raw(self, text: str) -> None:
        self.chunks.append(text)


@dataclass(frozen=True)
class SedFileText:
    """A file ``r`` or ``R`` names, read before the run."""

    text: str


@dataclass(frozen=True)
class SedFileError:
    """A file ``r`` or ``R`` names that opened and failed to read.

    A directory does: GNU panics with ``error`` when it gets there.
    """

    error: str


# A file `r` or `R` names: None when it could not be opened (GNU reads
# that as empty).
SedFileContent = SedFileText | SedFileError | None


@dataclass(frozen=True)
class SedInput:
    """One input operand in order: its text, or the stream it is read
    from as the run reaches it."""

    name: str
    text: str | None = None
    source: ByteSource | None = None


@dataclass(frozen=True)
class SedRunOptions:
    """How a machine runs.

    ``files`` is what each ``r`` file holds now; ``reader_files`` what
    each ``R`` file held when the script was compiled.
    """

    suppress: bool = False
    separate: bool = False
    line_length: int = SED_LINE_LENGTH
    files: Mapping[str, SedFileContent] = field(default_factory=dict)
    reader_files: Mapping[str, SedFileContent] = field(default_factory=dict)
    utf8: bool = False


class SedPanic(Exception):
    """Stop the run the way GNU's panic exits: a message, then exit 4."""

    def __init__(self, message: str, code: int = 4) -> None:
        super().__init__(message)
        self.message = message
        self.code = code


@dataclass
class _InputLine:
    text: str
    chomped: bool


@dataclass
class _Reader:
    lines: list[str]
    pos: int = 0


def _reader_lines(text: str) -> list[str]:
    """Cut an ``R`` file into lines, each with its newline if it had one.

    Args:
        text (str): the file's text.
    """
    out: list[str] = []
    start = 0
    while start < len(text):
        nl = text.find("\n", start)
        end = len(text) if nl < 0 else nl + 1
        out.append(text[start:end])
        start = end
    return out


def _case_mapped(text: str, upper: bool, utf8: bool = False) -> str:
    """``text`` with its ASCII letters mapped, as the C locale maps them.

    Args:
        text (str): a byte view.
        upper (bool): map to upper case rather than lower.
        utf8 (bool): ``text`` is the text itself, under a UTF-8 locale.
    """
    raw = from_byte_view(text, utf8)
    return byte_view(raw.upper() if upper else raw.lower(), utf8)


def _apply_repl(m: "re.Match[str]", repl: str, utf8: bool = False) -> str:
    """Expand a GNU sed replacement against a match.

    ``&`` is the whole match, ``\\1``..``\\9`` are groups, ``\\&`` is a
    literal ``&``, ``\\n``/``\\t`` are newline/tab, and ``\\X`` is a
    literal X.

    ``\\U`` and ``\\L`` map everything after them to upper or lower case
    until ``\\E`` or the other one; ``\\u`` and ``\\l`` map only the next
    character, and one that lands on an empty group passes to what
    directly follows the group. Every case escape drops a one-shot still
    waiting, written before it or carried to it, so the later of two
    one-shots wins: GNU sed 4.9's ``setup_replacement`` cuts the
    replacement at each escape and ``append_replacement`` hands a carried
    one-shot to the next piece only. The C locale maps ASCII letters only,
    so a byte above 0x7f is written as it is; GNU 4.9 writes 0xff for it,
    which is not copied.

    Args:
        m (re.Match): The regex match for the current substitution.
        repl (str): The sed replacement template.
        utf8 (bool): the match is text under a UTF-8 locale; the case
            escapes still map ASCII letters only.
    """
    out: list[str] = []
    sticky: bool | None = None
    pending: bool | None = None
    carried: bool | None = None

    def emit(piece: str, group: bool = False) -> None:
        nonlocal pending, carried
        first = pending if pending is not None else carried
        own = pending is not None
        pending = carried = None
        if not piece:
            if group and own:
                carried = first
            return
        if first is not None:
            out.append(_case_mapped(piece[0], first, utf8))
            piece = piece[1:]
        out.append(
            piece if sticky is None else _case_mapped(piece, sticky, utf8)
        )

    i = 0
    while i < len(repl):
        ch = repl[i]
        if ch == "\\" and i + 1 < len(repl):
            nxt = repl[i + 1]
            if nxt in "0123456789":
                emit(m.group(int(nxt)) or "", group=True)
            elif nxt in "ULE":
                sticky = None if nxt == "E" else nxt == "U"
                pending = carried = None
            elif nxt in "ul":
                pending = nxt == "u"
                carried = None
            elif nxt == "n":
                emit("\n")
            elif nxt == "t":
                emit("\t")
            else:
                emit(nxt)
            i += 2
        elif ch == "&":
            emit(m.group(0), group=True)
            i += 1
        else:
            emit(ch)
            i += 1
    return "".join(out)


class SedMachine:
    """GNU sed 4.9's execute.c over a compiled program.

    One machine lives for the whole command: the ``w`` files, the ``R``
    readers, the hold space and the last regex carry across its runs, so
    -i can run it once per file. ``stdout`` collects what goes to stdout
    and /dev/stdout; ``process`` returns the main output, which is stdout
    itself unless -i sends it to the file.
    """

    def __init__(self, program: SedProgram, opts: SedRunOptions) -> None:
        self._budget = YieldBudget()
        self._reader: AsyncLineIterator | None = None
        self.program = program
        self.opts = opts
        self._files = opts.files
        self.no_default_output = opts.suppress or program.no_default_output
        self.stdout = SedOutput()
        self.stderr_lines: list[str] = []
        self.wfiles: dict[str, SedOutput] = {
            name: SedOutput()
            for name in program.wfiles
            if name not in (SED_STDOUT, SED_STDERR)
        }
        self.quit_code: int | None = None
        self.panic_code: int | None = None
        self.bad_code = 0
        self._compiled: dict[tuple[SedRegex, bool], re.Pattern[str]] = {}
        self._readers: dict[str, _Reader | None] = {}
        self._range_state = [_RANGE_INACTIVE] * len(program.commands)
        self._a2_number = [0] * len(program.commands)
        self._special_out = SedOutput(self.stdout.chunks)
        self._special_err = SedOutput()
        self._last_regex: SedRegex | None = None
        self._main = self.stdout
        self._inputs: list[SedInput] = []
        self._file_idx = 0
        self._next_line: _InputLine | None = None
        self._file_name = "-"
        self._reset_at_next_file = True
        self._line_number = 0
        self._pattern = ""
        self._chomped = True
        self._hold = ""
        self._replaced = False
        self._append_queue: list[tuple[str, str | None]] = []

    def stderr(self) -> str:
        """What the program wrote to /dev/stderr, then the error lines."""
        return text_view(
            "".join(self._special_err.chunks), self.opts.utf8
        ) + "".join(self.stderr_lines)

    def exit_code(self) -> int:
        """The exit status GNU would end with after the runs so far."""
        if self.panic_code is not None:
            return self.panic_code
        if self.bad_code:
            return self.bad_code
        return (self.quit_code or 0) & 0xFF

    def stopped(self) -> bool:
        """Whether a ``q``, ``Q`` or panic ended the run."""
        return self.quit_code is not None or self.panic_code is not None

    async def process(
        self, inputs: list[SedInput], to_stdout: bool
    ) -> AsyncGenerator[str, None]:
        """Run the program over ``inputs`` as one stream.

        With ``separate`` each file is its own stream. The main output is
        yielded as it is reached: stdout's, or, when ``to_stdout`` is
        False, a fresh stream's (-i's per-file output).

        Args:
            inputs (list[SedInput]): the operands in order.
            to_stdout (bool): whether the main output is stdout.
        """
        out = self.stdout if to_stdout else SedOutput()
        self._main = out
        self._inputs = inputs
        self._file_idx = 0
        self._next_line = None
        self._reset_at_next_file = True
        try:
            while not self.stopped():
                if self._append_queue:
                    self._dump_append_queue()
                if out.chunks:
                    chunk = "".join(out.chunks)
                    out.chunks.clear()
                    yield chunk
                if not await self._read_pattern_space(False):
                    break
                async for status in self._execute_program():
                    if status != -1:
                        self.quit_code = status
                    if out.chunks:
                        yield "".join(out.chunks)
                        out.chunks.clear()
        except SedPanic as exc:
            self.panic_code = exc.code
            self.stderr_lines.append(exc.message)
        finally:
            if self._reader is not None:
                await self._reader.discard()
        if out.chunks:
            yield "".join(out.chunks)
            out.chunks.clear()

    def _reset_addresses(self) -> None:
        for i, cmd in enumerate(self.program.commands):
            a1 = cmd.a1
            self._range_state[i] = (
                _RANGE_ACTIVE
                if a1 is not None and a1.kind == "num" and a1.n == 0
                else _RANGE_INACTIVE
            )

    def _open_next_file(self) -> bool:
        if self._file_idx >= len(self._inputs):
            return False
        nxt = self._inputs[self._file_idx]
        self._file_idx += 1
        self._file_name = nxt.name
        self._reader = AsyncLineIterator(
            nxt.source
            if nxt.source is not None
            else from_byte_view(nxt.text or "", self.opts.utf8)
        )
        self._next_line = None
        return True

    async def _more(self, peek: bool = False) -> bool:
        """Read this operand's next line ahead; whether there is one.

        A failed operand goes GNU sed 4.9's ways. One that never opens (a
        missing file; stdin is always open) is reported, exit 2, and the
        run reads on. One that opens and then fails to read (a directory,
        or a read that breaks off) panics, exit 4. The look-ahead of
        ``$``, ``n`` and ``N`` only peeks for one more byte, so a line
        still arriving never holds it up: a peek that fails reads as the
        operand's end, and a byte already buffered leaves the failure to
        the read that takes the line.

        Args:
            peek (bool): ask for one more byte rather than read the line.
        """
        if self._next_line is not None:
            return True
        if self._reader is None:
            return False
        try:
            if peek:
                return await self._reader.peek()
            raw, chomped = await self._reader.read_until(b"\n")
        except FS_ERRORS as exc:
            path = PathSpec.from_str_path(self._file_name)
            unopened = never_opened(self._reader, path, exc)
            await self._reader.discard()
            self._reader = None
            if unopened:
                self.stderr_lines.append(fs_error_line("sed", path, exc))
                self.bad_code = max(
                    self.bad_code, read_fail_exit_code("sed", exc)
                )
                return False
            if peek:
                return False
            name = "stdin" if self._file_name == "-" else self._file_name
            raise SedPanic(
                f"sed: read error on {name}: {fs_strerror(exc) or exc}\n"
            ) from exc
        if raw or chomped:
            self._next_line = _InputLine(
                byte_view(raw, self.opts.utf8), chomped
            )
        return self._next_line is not None

    async def _read_pattern_space(self, append: bool) -> bool:
        self._replaced = False
        while not await self._more():
            if self._file_idx >= len(self._inputs):
                return False
            if self._reset_at_next_file:
                self._line_number = 0
                self._hold = ""
                self._reset_addresses()
                for reader in self._readers.values():
                    if reader is not None:
                        reader.pos = 0
                self._reset_at_next_file = self.opts.separate
            if not self._open_next_file():
                return False
        line, self._next_line = self._next_line, None
        assert line is not None
        self._pattern = self._pattern + line.text if append else line.text
        self._chomped = line.chomped
        self._line_number += 1
        return True

    async def _test_eof(self) -> bool:
        """GNU's test_eof for ``$``, ``n`` and ``N``.

        This operand has no more lines and, unless files are separate,
        neither has any later one. The later operands are opened on the
        way, so their errors are reported now.
        """
        if await self._more(peek=True):
            return False
        if self.opts.separate:
            return True
        while self._open_next_file():
            if await self._more(peek=True):
                return False
        return True

    def _regex(self, regex: SedRegex | None, global_: bool) -> re.Pattern[str]:
        use = regex if regex is not None else self._last_regex
        if use is None:
            raise SedPanic(
                f"sed: {self.program.end_where}: "
                "no previous regular expression\n",
                1,
            )
        self._last_regex = use
        key = (use, global_)
        hit = self._compiled.get(key)
        if hit is None:
            hit = compile_posix_regex(
                use.source, sed_regex_flags(use), self.opts.utf8
            )
            self._compiled[key] = hit
        return hit

    async def _match_one(self, addr: SedAddr, index: int) -> bool:
        kind = addr.kind
        if kind == "null":
            return True
        if kind == "regex":
            return (
                self._regex(addr.re, False).search(self._pattern) is not None
            )
        if kind == "mod":
            return (
                self._line_number >= addr.n
                and (self._line_number - addr.n) % addr.step == 0
            )
        if kind in ("step", "stepmod"):
            return self._a2_number[index] <= self._line_number
        if kind == "last":
            return await self._test_eof()
        return addr.n == self._line_number

    async def _match_address(self, cmd: SedCommand, index: int) -> bool:
        """GNU's match_address_p, range states and all.

        Args:
            cmd (SedCommand): the command.
            index (int): its position, which keys its range state.
        """
        a1 = cmd.a1
        a2 = cmd.a2
        if a1 is None:
            return True
        line = self._line_number
        if self._range_state[index] != _RANGE_ACTIVE:
            if a2 is None:
                return await self._match_one(a1, index)
            if a1.kind == "num":
                if self._range_state[index] == _RANGE_CLOSED or line < a1.n:
                    return False
            elif not await self._match_one(a1, index):
                return False
            self._range_state[index] = _RANGE_ACTIVE
            if a2.kind == "regex":
                return True
            if a2.kind == "num":
                if line >= a2.n:
                    self._range_state[index] = _RANGE_CLOSED
                return line <= a2.n or await self._match_one(a1, index)
            if a2.kind == "step":
                self._a2_number[index] = line + a2.n
                return True
            if a2.kind == "stepmod":
                self._a2_number[index] = line + a2.n - (line % a2.n)
                return True
        if a2 is None:
            return True
        if a2.kind == "num":
            if line >= a2.n:
                self._range_state[index] = _RANGE_CLOSED
            return line <= a2.n
        if await self._match_one(a2, index):
            self._range_state[index] = _RANGE_CLOSED
        return True

    def set_files(self, files: Mapping[str, SedFileContent]) -> None:
        """Replace what the ``r`` files hold.

        GNU opens an ``r`` file each time the append queue is written, so
        under -i a file edited earlier in the command reads with its new
        content; within one run nothing it reads changes (a ``w`` file
        stays in its stdio buffer until sed exits).

        Args:
            files (Mapping[str, SedFileContent]): the ``r`` files now.
        """
        self._files = files

    def _file_text(self, name: str) -> str:
        content = self._files.get(name)
        if content is None:
            return ""
        if isinstance(content, SedFileError):
            raise SedPanic(content.error)
        return content.text

    def _dump_append_queue(self) -> None:
        self._main.flush_newline()
        queue = self._append_queue
        self._append_queue = []
        for text, rfile in queue:
            self._main.raw(text)
            if rfile is not None:
                self._main.raw(self._file_text(rfile))

    def _output_for(self, name: str) -> SedOutput:
        if name == SED_STDOUT:
            return self._special_out
        if name == SED_STDERR:
            return self._special_err
        return self.wfiles.setdefault(name, SedOutput())

    def _read_line(self, name: str) -> str | None:
        if name not in self._readers:
            content = self.opts.reader_files.get(name)
            if isinstance(content, SedFileError):
                raise SedPanic(content.error)
            self._readers[name] = (
                None
                if content is None
                else _Reader(_reader_lines(content.text))
            )
        reader = self._readers[name]
        if reader is None or reader.pos >= len(reader.lines):
            return None
        line = reader.lines[reader.pos]
        reader.pos += 1
        return line

    def _substitute(self, cmd: SedCommand) -> None:
        sub = cmd.subst
        if sub is None:
            return
        scan = self._regex(sub.re, True)
        nth = sub.numb or 1
        counter = 0
        last_end = -1
        done = False

        def replace(m: "re.Match[str]") -> str:
            nonlocal counter, last_end, done
            if m.start() == m.end() == last_end:
                return ""
            if m.end() > m.start():
                last_end = m.end()
            counter += 1
            hit = counter >= nth if sub.global_ else counter == nth
            if not hit:
                return m.group(0)
            done = True
            return _apply_repl(m, sub.replacement, self.opts.utf8)

        result = scan.sub(replace, self._pattern)
        if not done:
            return
        self._replaced = True
        self._pattern = result
        if sub.print_:
            self._main.line(self._pattern, self._chomped)
        if sub.outf is not None:
            self._output_for(sub.outf).line(self._pattern, self._chomped)

    def _transliterate(self, cmd: SedCommand) -> None:
        table = dict(zip(cmd.y_src, cmd.y_dst))
        self._pattern = "".join(table.get(ch, ch) for ch in self._pattern)

    async def _execute_program(self) -> AsyncIterator[int]:
        """One cycle of the script.

        Yields -1 wherever the output so far may go out (before each
        command, and before ``n`` or ``N`` reads on), or the exit status
        ``q`` or ``Q`` stops with.
        """
        commands = self.program.commands
        pc = 0
        while pc < len(commands):
            await self._budget.run()
            yield -1
            cmd = commands[pc]
            c = cmd.cmd
            if await self._match_address(cmd, pc) == cmd.bang:
                pc += 1
                continue
            if c == "a":
                if cmd.text is not None:
                    self._append_queue.append((cmd.text, None))
            elif c in ("{", "b"):
                pc = cmd.jump
                continue
            elif c == "c":
                if (
                    self._range_state[pc] != _RANGE_ACTIVE
                    and cmd.text is not None
                ):
                    self._main.line(cmd.text[:-1], True)
                return
            elif c == "d":
                return
            elif c == "D":
                nl = self._pattern.find("\n")
                if nl < 0:
                    return
                self._pattern = self._pattern[nl + 1 :]
                pc = 0
                continue
            elif c == "g":
                self._pattern = self._hold
            elif c == "G":
                self._pattern += "\n" + self._hold
            elif c == "h":
                self._hold = self._pattern
            elif c == "H":
                self._hold += "\n" + self._pattern
            elif c == "i":
                if cmd.text is not None:
                    self._main.line(cmd.text[:-1], True)
            elif c == "l":
                width = (
                    self.opts.line_length if cmd.int_arg == -1 else cmd.int_arg
                )
                self._main.flush_newline()
                self._main.raw(list_line(self._pattern, width, self.opts.utf8))
            elif c == "L":
                # GNU 4.9 still compiles the removed `L` and then has no
                # case for it: an internal error the moment it runs.
                raise SedPanic("sed: INTERNAL ERROR: Bad cmd L\n")
            elif c == "n":
                if not self.no_default_output:
                    self._main.line(self._pattern, self._chomped)
                if self._append_queue:
                    self._dump_append_queue()
                yield -1
                if (
                    await self._test_eof()
                    or not await self._read_pattern_space(False)
                ):
                    return
            elif c == "N":
                self._pattern += "\n"
                if self._append_queue:
                    self._dump_append_queue()
                yield -1
                if (
                    await self._test_eof()
                    or not await self._read_pattern_space(True)
                ):
                    self._pattern = self._pattern[:-1]
                    if not self.no_default_output:
                        self._main.line(self._pattern, self._chomped)
                    return
            elif c == "p":
                self._main.line(self._pattern, self._chomped)
            elif c == "P":
                nl = self._pattern.find("\n")
                if nl >= 0:
                    self._main.line(self._pattern[:nl], True)
                else:
                    self._main.line(self._pattern, self._chomped)
            elif c == "q":
                if not self.no_default_output:
                    self._main.line(self._pattern, self._chomped)
                self._dump_append_queue()
                yield 0 if cmd.int_arg == -1 else cmd.int_arg
                return
            elif c == "Q":
                yield 0 if cmd.int_arg == -1 else cmd.int_arg
                return
            elif c == "r":
                if cmd.prepend:
                    self._main.flush_newline()
                    self._main.raw(self._file_text(cmd.fname))
                else:
                    self._append_queue.append(("", cmd.fname))
            elif c == "R":
                text = self._read_line(cmd.fname)
                if text is not None:
                    self._append_queue.append((text, None))
            elif c == "s":
                self._substitute(cmd)
            elif c == "t":
                if self._replaced:
                    self._replaced = False
                    pc = cmd.jump
                    continue
            elif c == "T":
                if not self._replaced:
                    pc = cmd.jump
                    continue
                self._replaced = False
            elif c == "w":
                self._output_for(cmd.fname).line(self._pattern, self._chomped)
            elif c == "W":
                out = self._output_for(cmd.fname)
                nl = self._pattern.find("\n")
                if nl >= 0:
                    out.line(self._pattern[:nl], True)
                else:
                    out.line(self._pattern, self._chomped)
            elif c == "x":
                self._pattern, self._hold = self._hold, self._pattern
            elif c == "y":
                self._transliterate(cmd)
            elif c == "z":
                self._pattern = ""
            elif c == "=":
                self._main.flush_newline()
                self._main.raw(f"{self._line_number}\n")
            elif c == "F":
                self._main.flush_newline()
                self._main.raw(
                    byte_view(f"{self._file_name}\n", self.opts.utf8)
                )
            pc += 1
        if not self.no_default_output:
            self._main.line(self._pattern, self._chomped)
