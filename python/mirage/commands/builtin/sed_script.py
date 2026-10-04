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
from dataclasses import dataclass, field
from enum import Enum

from mirage.commands.builtin.utils.bre import (
    BreError,
    PosixSyntax,
    translate_bre,
    translate_ere,
)
from mirage.shell.bytes import byte_char, byte_view, encode_text
from mirage.utils.posix import compile_posix_regex

SED_VERSION = "4.9"

SED_STDOUT = "/dev/stdout"
SED_STDERR = "/dev/stderr"


@dataclass(frozen=True, eq=False)
class SedRegex:
    """One regex of a script; ``None`` in its place means the last one run.

    ``pattern`` is the text between the delimiters; ``source`` is the host
    regex it compiles to, through GNU's escape pre-pass and the glibc
    translator. Compared by identity, as each is one regex of the script.
    """

    pattern: str
    source: str = ""
    groups: int = 0
    icase: bool = False
    multiline: bool = False


def sed_regex_flags(regex: SedRegex) -> int:
    """The host flags a sed regex compiles with.

    GNU sed's regex syntax has RE_DOT_NEWLINE, so ``.`` matches the
    newline ``N`` puts in the pattern space; ``M`` (REG_NEWLINE) takes
    that away and makes ``^`` and ``$`` line anchors. Divergence: the host
    has no buffer-only anchor in multiline mode, so under ``M`` GNU's
    buffer anchors (backslash-backquote, backslash-quote) anchor at lines
    too, and ``[^a]`` still matches a newline.

    Args:
        regex (SedRegex): the compiled regex.
    """
    flags = re.IGNORECASE if regex.icase else 0
    return flags | (re.MULTILINE if regex.multiline else re.DOTALL)


def _line_anchors(source: str) -> str:
    """Spell the translator's buffer anchors as ``re.MULTILINE`` lines.

    Args:
        source (str): translated host source.
    """
    out: list[str] = []
    i = 0
    while i < len(source):
        pair = source[i : i + 2]
        if pair == "\\Z":
            out.append("$")
        elif pair == "\\A":
            out.append("^")
        elif source[i] == "\\":
            out.append(pair)
        else:
            out.append(source[i])
            i += 1
            continue
        i += 2
    return "".join(out)


@dataclass(frozen=True)
class SedAddr:
    """One address: ``num`` (n), ``mod`` (n~step), ``step`` (+n),
    ``stepmod`` (~n), ``last`` ($), ``null`` (+0 / ~0) or ``regex``."""

    kind: str
    n: int = 0
    step: int = 0
    re: SedRegex | None = None


@dataclass
class SedSubst:
    re: SedRegex | None
    replacement: str
    global_: bool = False
    print_: bool = False
    numb: int = 0
    outf: str | None = None


@dataclass
class SedCommand:
    """One compiled command.

    ``text`` is a/i/c text with its closing newline, ``None`` for none.
    ``jump`` is the resolved target of ``{``, ``b``, ``t`` and ``T``: the
    index of the matching ``}`` or label, or the script's length.
    ``int_arg`` is the number after ``l``, ``q`` or ``Q``, -1 for none.
    ``prepend`` marks ``0r FILE``, written before the first line.
    """

    cmd: str
    a1: SedAddr | None = None
    a2: SedAddr | None = None
    bang: bool = False
    text: str | None = None
    label: str = ""
    jump: int = -1
    int_arg: int = -1
    fname: str = ""
    prepend: bool = False
    subst: SedSubst | None = None
    y_src: list[str] = field(default_factory=list)
    y_dst: list[str] = field(default_factory=list)


@dataclass
class SedProgram:
    """A compiled script.

    ``no_default_output`` is ``#n`` on the first line. ``wfiles`` are the
    files ``w``, ``W`` and ``s///w`` write, in the order GNU opens
    (truncates) them; ``rfiles`` the files ``r`` reads (again at every
    append) and ``reader_files`` those ``R`` reads (opened once, as GNU
    opens them when it compiles the command).
    ``end_where`` is where GNU places an error found once the script has
    run out, as a missing previous regex at run time.
    """

    commands: list[SedCommand]
    no_default_output: bool
    wfiles: list[str]
    rfiles: list[str]
    reader_files: list[str]
    end_where: str


@dataclass(frozen=True)
class SedScriptPiece:
    """One -e expression or -f script file, in command-line order.

    ``name`` is the script file's name as given, for ``file NAME line N:``.
    """

    kind: str
    text: str
    name: str = "-"


class SedText(Enum):
    """What a piece of script text is, as GNU's ``text_types``.

    It decides what an escape spells: a regex and a replacement keep an
    unknown escape's backslash for their own reader, and a replacement
    quotes the ``\\`` or ``&`` a numeric escape spells, so it stays a
    literal byte rather than a backreference.
    """

    BUFFER = "buffer"
    REPLACEMENT = "replacement"
    REGEX = "regex"


class SedError(ValueError):
    """A script GNU refuses.

    ``wfiles`` are the files the script had opened (and so truncated)
    before the error, since GNU opens a ``w`` file the moment it compiles
    the command. ``exit_code`` is 1 for a syntax error and 4 for GNU's
    panics (an undefined label).
    """

    def __init__(
        self, message: str, exit_code: int = 1, wfiles: Sequence[str] = ()
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.wfiles = tuple(wfiles)


BAD_BANG = "multiple `!'s"
BAD_COMMA = "unexpected `,'"
BAD_STEP = "invalid usage of +N or ~N as first address"
EXCESS_OPEN_BRACE = "unmatched `{'"
EXCESS_CLOSE_BRACE = "unexpected `}'"
EXCESS_JUNK = "extra characters after command"
EXPECTED_SLASH = "expected \\ after `a', `c' or `i'"
NO_CLOSE_BRACE_ADDR = "`}' doesn't want any addresses"
NO_COLON_ADDR = ": doesn't want any addresses"
NO_SHARP_ADDR = "comments don't accept any addresses"
NO_COMMAND = "missing command"
ONE_ADDR = "command only uses one address"
UNTERM_ADDR_RE = "unterminated address regex"
UNTERM_S_CMD = "unterminated `s' command"
UNTERM_Y_CMD = "unterminated `y' command"
UNKNOWN_S_OPT = "unknown option to `s'"
EXCESS_P_OPT = "multiple `p' options to `s' command"
EXCESS_G_OPT = "multiple `g' options to `s' command"
EXCESS_N_OPT = "multiple number options to `s' command"
ZERO_N_OPT = "number option to `s' command may not be zero"
Y_CMD_LEN = "strings for `y' command are different lengths"
BAD_DELIM = "delimiter character is not a single-byte character"
ANCIENT_VERSION = "expected newer version of sed"
INVALID_LINE_0 = "invalid usage of line address 0"
COLON_LACKS_LABEL = '":" lacks a label'
RECURSIVE_ESCAPE_C = "recursive escaping after \\c not allowed"
MISSING_FILENAME = "missing filename in r/R/w/W commands"
BAD_MODIF = "cannot specify modifiers on empty regexp"
INVALID_PATTERN = "Invalid regular expression"
UNMATCHED_CLOSE = "Unmatched ) or \\)"
# dfa.c's refusal of a bracket that looks like a class written without
# its outer brackets, which sed's dfawarn turns into a panic (exit 4).
CONFUSING_BRACKET = "character class syntax is [[:space:]], not [:space:]"
# GNU runs `e` and `s///e` through popen; mirage has no door to run a
# shell command from inside sed, so it refuses both where GNU compiles
# them, in the words GNU's own no-popen build uses at run time.
NO_EVAL = "`e' command not supported"

_TEXT_ESCAPES = {
    "a": "\x07",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\n": "\n",
}

_TEXT_ESCAPE_BASES = {"d": 10, "o": 8, "x": 16}

_SIMPLE = frozenset("=dDFgGhHnNpPzx")


def _is_blank(ch: str | None) -> bool:
    return ch in (" ", "\t")


def _is_space(ch: str | None) -> bool:
    return ch is not None and ch in " \t\n\v\f\r"


def _is_digit(ch: str | None) -> bool:
    return ch is not None and "0" <= ch <= "9"


def _first_byte(ch: str) -> str:
    """The first byte of one character, as GNU's bad_command prints it.

    Args:
        ch (str): the command character.
    """
    data = encode_text(ch)
    return ch if len(data) <= 1 else byte_char(data[0])


def _version_compare(a: str, b: str) -> int:
    """GNU's strverscmp over two versions: digit runs compare as numbers.

    Args:
        a (str): the version a script asks for.
        b (str): this sed's version.
    """
    pa = re.findall(r"\d+|\D+", a)
    pb = re.findall(r"\d+|\D+", b)
    for x, y in zip(pa, pb):
        if x.isdigit() and y.isdigit():
            if int(x) != int(y):
                return int(x) - int(y)
            continue
        if x != y:
            return -1 if x < y else 1
    return len(pa) - len(pb)


class _Compiler:
    """GNU sed 4.9's compile.c over one script given as -e and -f pieces.

    Pieces compile in order into one program, as GNU compiles each -e or
    -f in turn: an a/i/c text a piece leaves open on a backslash goes on
    in the next, a ``{`` in one closes in another, and labels are resolved
    once the last piece is read. Every blank and error position follows
    GNU: blanks and ``;`` before an address, blanks after one, around the
    range comma and after ``!``, then the command's own rules.
    """

    def __init__(self, extended: bool) -> None:
        self.extended = extended
        self.chars: list[str] = []
        self.pos = 0
        self.line = 0
        self.name: str | None = None
        self.expr_count = 0
        self.first_script = True
        self.commands: list[SedCommand] = []
        self.blocks: list[tuple[int, str]] = []
        self.labels: dict[str, int] = {}
        self.jumps: list[tuple[int, str]] = []
        self.pending_text: str | None = None
        self.old_text_cmd: SedCommand | None = None
        self.no_default_output = False
        self.wfiles: list[str] = []
        self.rfiles: list[str] = []
        self.reader_files: list[str] = []

    def compile(self, pieces: Sequence[SedScriptPiece]) -> SedProgram:
        for piece in pieces:
            self.chars = list(piece.text)
            self.pos = 0
            if piece.kind == "file":
                self.line = 1
                self.name = piece.name
            else:
                self.line = 0
                self.name = None
                self.expr_count += 1
            self._compile_program()
            self.first_script = False
        self._check_final()
        return SedProgram(
            commands=self.commands,
            no_default_output=self.no_default_output,
            wfiles=self.wfiles,
            rfiles=self.rfiles,
            reader_files=self.reader_files,
            end_where=self._block_where(),
        )

    def _where(self, unread: int = 0) -> str:
        """Where GNU reports an error.

        Args:
            unread (int): bytes of the last character GNU, reading byte by
                byte, has not reached: an unknown command stops after the
                first byte of a multibyte character.
        """
        if self.name is not None:
            return f"file {self.name} line {self.line}"
        consumed = len(encode_text("".join(self.chars[: self.pos]))) - unread
        return f"-e expression #{self.expr_count}, char {consumed}"

    def _bad(self, why: str, unread: int = 0) -> SedError:
        return SedError(f"sed: {self._where(unread)}: {why}", 1, self.wfiles)

    def _block_where(self) -> str:
        """Where an unmatched ``{`` is reported.

        GNU keeps the block's line but no longer has a position within
        the expression, so it says char 0.
        """
        if self.name is not None:
            return f"file {self.name} line {self.line}"
        return f"-e expression #{self.expr_count}, char 0"

    def _inchar(self) -> str | None:
        if self.pos >= len(self.chars):
            return None
        ch = self.chars[self.pos]
        self.pos += 1
        if ch == "\n":
            self.line += 1
        return ch

    def _savchar(self, ch: str | None) -> None:
        if ch is None:
            return
        if ch == "\n" and self.line > 0:
            self.line -= 1
        self.pos -= 1

    def _in_nonblank(self) -> str | None:
        ch = self._inchar()
        while _is_blank(ch):
            ch = self._inchar()
        return ch

    def _read_end_of_cmd(self) -> None:
        ch = self._in_nonblank()
        if ch in ("}", "#"):
            self._savchar(ch)
        elif ch is not None and ch not in ("\n", ";"):
            raise self._bad(EXCESS_JUNK)

    def _in_integer(self, first: str | None) -> int:
        num = 0
        ch = first
        while ch is not None and _is_digit(ch):
            num = num * 10 + int(ch)
            ch = self._inchar()
        self._savchar(ch)
        return num

    def _read_filename(self) -> str:
        out: list[str] = []
        ch = self._in_nonblank()
        while ch is not None and ch != "\n":
            out.append(ch)
            ch = self._inchar()
        return "".join(out)

    def _open_file(self, write: bool) -> str:
        name = self._read_filename()
        if not name:
            raise self._bad(MISSING_FILENAME)
        names = self.wfiles if write else self.reader_files
        if name not in names:
            names.append(name)
        return name

    def _read_label(self) -> str:
        """A label for ``:``, ``b``, ``t``, ``T`` or ``v``.

        It ends at a blank, ``;``, ``}``, ``#`` or the end of the line.
        """
        out: list[str] = []
        ch = self._in_nonblank()
        while (
            ch is not None
            and ch != "\n"
            and not _is_blank(ch)
            and ch not in (";", "}", "#")
        ):
            out.append(ch)
            ch = self._inchar()
        self._savchar(ch)
        return "".join(out)

    def _snarf_char_class(self, buf: list[str]) -> str | None:
        state = 0
        delim = ""
        ch = self._inchar()
        if ch == "^":
            buf.append(ch)
            ch = self._inchar()
        if ch == "]":
            buf.append(ch)
            ch = self._inchar()
        while True:
            if ch is None or ch == "\n":
                return ch
            advance = True
            if ch in (".", ":", "="):
                if state == 1:
                    delim = ch
                    state = 2
                    advance = False
                elif state == 2 and ch == delim:
                    state = 3
                    advance = False
            elif ch == "[":
                if state == 0:
                    state = 1
                advance = False
            elif ch == "]":
                if state in (0, 1):
                    return ch
                if state == 3:
                    state = 0
            if advance:
                state &= ~1
            buf.append(ch)
            ch = self._inchar()

    def _match_slash(self, slash: str | None, regex: bool) -> str | None:
        """GNU's match_slash: read up to the closing delimiter.

        A backslash before the delimiter is dropped (so ``s|a\\|b||``
        matches a literal ``a|b``), before a newline it leaves the
        newline, and before anything else it stays. In a regex a bracket
        expression is read whole, so a delimiter inside ``[...]`` does not
        end it.

        Args:
            slash (str | None): the delimiter.
            regex (bool): whether the field is a regex.
        """
        if slash is not None and ord(slash) > 0x7F:
            raise self._bad(BAD_DELIM)
        buf: list[str] = []
        ch = self._inchar()
        while ch is not None and ch != "\n":
            if ch == slash:
                return "".join(buf)
            if ch == "\\":
                ch = self._inchar()
                if ch is None:
                    break
                if ch != "\n" and (ch != slash or (not regex and ch == "&")):
                    buf.append("\\")
            elif ch == "[" and regex:
                buf.append(ch)
                ch = self._snarf_char_class(buf)
                if ch != "]":
                    break
            buf.append(ch)
            ch = self._inchar()
        if ch == "\n":
            self._savchar(ch)
        return None

    def _regex(
        self, pattern: str, icase: bool, multiline: bool, reference: int = 0
    ) -> SedRegex | None:
        """GNU's compile_regex.

        normalize_text's escapes, then regcomp in the basic or extended
        syntax (here the glibc translator), whose refusal is reported
        where the command was read, then dfa's bracket check. An ``s``
        whose replacement names a group the regex lacks is refused too.

        Args:
            pattern (str): the text between the delimiters.
            icase (bool): ``I``.
            multiline (bool): ``M``.
            reference (int): the highest group the replacement names.
        """
        if not pattern:
            if icase or multiline:
                raise self._bad(BAD_MODIF)
            return None
        normalized = self._normalize_text(pattern, SedText.REGEX)
        try:
            if self.extended:
                # GNU sed clears RE_UNMATCHED_RIGHT_PAREN_ORD, which the
                # POSIX extended syntax sets: an unmatched `)` is refused,
                # unless the pattern before it is already refused.
                close = _unmatched_close_paren(normalized)
                if close >= 0:
                    translate_ere(normalized[:close], PosixSyntax.EXTENDED)
                    raise BreError(UNMATCHED_CLOSE)
                source, groups, _ = translate_ere(
                    normalized, PosixSyntax.EXTENDED
                )
            else:
                source, groups = translate_bre(normalized, True)
        except BreError as exc:
            raise self._bad(str(exc)) from exc
        if multiline:
            source = _line_anchors(source)
        regex = SedRegex(pattern, source, groups, icase, multiline)
        try:
            compile_posix_regex(source, sed_regex_flags(regex))
        except re.error as exc:
            raise self._bad(INVALID_PATTERN) from exc
        if reference > groups:
            raise self._bad(
                f"invalid reference \\{reference} on `s' command's RHS"
            )
        if _confusing_bracket(normalized):
            raise SedError(f"sed: {CONFUSING_BRACKET}", 4, self.wfiles)
        return regex

    def _normalize_text(
        self, text: str, kind: SedText = SedText.BUFFER
    ) -> str:
        """GNU's normalize_text, over the text's byte view.

        C escapes, ``\\dNNN``, ``\\oNNN`` and ``\\xHH`` bytes and
        ``\\cX`` control characters. In a text buffer (a/i/c and y) a
        backslash before any other character is dropped; in a regex it
        stays for regcomp, and what an escape produced is read as regex
        syntax, so ``\\x2e`` is any character and ``\\x5c`` a trailing
        backslash.

        Args:
            text (str): the text as read.
            kind (SedText): which part of the script it is.
        """
        buf = byte_view(text)
        out: list[str] = []
        i = 0
        while i < len(buf):
            ch = buf[i]
            if ch != "\\" or i + 1 >= len(buf):
                out.append(ch)
                i += 1
                continue
            nx = buf[i + 1]
            i += 2
            simple = _TEXT_ESCAPES.get(nx)
            if simple is not None:
                out.append(simple)
                continue
            base = _TEXT_ESCAPE_BASES.get(nx)
            if base is not None:
                value = 0
                digits = 0
                limit = 1
                while i < len(buf) and limit <= 255:
                    d = (
                        int(buf[i], 16)
                        if buf[i] in "0123456789abcdefABCDEF"
                        else base
                    )
                    if d >= base:
                        break
                    value = value * base + d
                    digits += 1
                    i += 1
                    limit *= base
                char = chr(value & 0xFF) if digits else nx
                if kind is SedText.REPLACEMENT and digits and char in "\\&":
                    out.append("\\")
                out.append(char)
                continue
            if nx == "c":
                if i >= len(buf):
                    if kind is SedText.REGEX:
                        out.append("\\")
                    continue
                x = buf[i]
                upper = x.upper() if "a" <= x <= "z" else x
                char = chr(ord(upper) ^ 0x40)
                if kind is SedText.REPLACEMENT and char in "\\&":
                    out.append("\\")
                out.append(char)
                i += 1
                if x == "\\":
                    if buf[i : i + 1] != "\\":
                        raise self._bad(RECURSIVE_ESCAPE_C)
                    i += 1
                continue
            out.append(nx if kind is SedText.BUFFER else "\\" + nx)
        return "".join(out)

    def _read_text(self, cmd: SedCommand | None, leadin: str | None) -> None:
        """GNU's read_text.

        The text runs to the first newline no backslash escapes and keeps
        that newline; a piece that ends on a backslash leaves the text
        pending for the next piece.

        Args:
            cmd (SedCommand | None): the a/i/c command, or None to go on
                with the pending text.
            leadin (str | None): the text's first character, or a newline
                for none.
        """
        if cmd is not None:
            self.pending_text = ""
            cmd.text = None
            self.old_text_cmd = cmd
        if leadin is None:
            return
        pending = [self.pending_text or ""]
        if leadin != "\n":
            pending.append(leadin)
        ch = self._inchar()
        while ch is not None and ch != "\n":
            if ch == "\\":
                ch = self._inchar()
                if ch is not None:
                    pending.append("\\")
            if ch is None:
                pending.append("\n")
                self.pending_text = "".join(pending)
                return
            pending.append(ch)
            ch = self._inchar()
        pending.append("\n")
        target = cmd if cmd is not None else self.old_text_cmd
        if target is not None:
            target.text = self._normalize_text("".join(pending))
        self.pending_text = None

    def _compile_address(self, first: str | None) -> SedAddr | None:
        ch = first
        if ch in ("/", "\\"):
            if ch == "\\":
                ch = self._inchar()
            pattern = self._match_slash(ch, True)
            if pattern is None:
                raise self._bad(UNTERM_ADDR_RE)
            icase = False
            multiline = False
            while True:
                ch = self._in_nonblank()
                if ch == "I":
                    icase = True
                elif ch == "M":
                    multiline = True
                else:
                    self._savchar(ch)
                    return SedAddr(
                        "regex", re=self._regex(pattern, icase, multiline)
                    )
        if _is_digit(ch):
            n = self._in_integer(ch)
            ch = self._in_nonblank()
            if ch != "~":
                self._savchar(ch)
                return SedAddr("num", n=n)
            step = self._in_integer(self._in_nonblank())
            return (
                SedAddr("mod", n=n, step=step)
                if step > 0
                else SedAddr("num", n=n)
            )
        if ch in ("+", "~"):
            step = self._in_integer(self._in_nonblank())
            if step == 0:
                return SedAddr("null")
            return SedAddr("step" if ch == "+" else "stepmod", n=step)
        if ch == "$":
            return SedAddr("last")
        return None

    def _mark_subst_opts(self, sub: SedSubst) -> tuple[bool, bool]:
        icase = False
        multiline = False
        while True:
            ch = self._in_nonblank()
            if ch in ("i", "I"):
                icase = True
            elif ch in ("m", "M"):
                multiline = True
            elif ch == "e":
                raise self._bad(NO_EVAL)
            elif ch == "p":
                if sub.print_:
                    raise self._bad(EXCESS_P_OPT)
                sub.print_ = True
            elif ch == "g":
                if sub.global_:
                    raise self._bad(EXCESS_G_OPT)
                sub.global_ = True
            elif ch == "w":
                sub.outf = self._open_file(True)
                return icase, multiline
            elif ch in ("}", "#"):
                self._savchar(ch)
                return icase, multiline
            elif ch is None or ch in ("\n", ";"):
                return icase, multiline
            elif ch == "\r":
                if self._inchar() == "\n":
                    return icase, multiline
                raise self._bad(UNKNOWN_S_OPT)
            elif _is_digit(ch):
                if sub.numb:
                    raise self._bad(EXCESS_N_OPT)
                sub.numb = self._in_integer(ch)
                if not sub.numb:
                    raise self._bad(ZERO_N_OPT)
            else:
                raise self._bad(UNKNOWN_S_OPT)

    def _compile_program(self) -> None:
        if self.pending_text is not None:
            self._read_text(None, "\n")
        while True:
            ch = self._inchar()
            while ch == ";" or _is_space(ch):
                ch = self._inchar()
            if ch is None:
                break
            cmd = SedCommand(cmd="")
            a1 = self._compile_address(ch)
            if a1 is not None:
                if a1.kind in ("step", "stepmod"):
                    raise self._bad(BAD_STEP)
                cmd.a1 = a1
                ch = self._in_nonblank()
                if ch == ",":
                    a2 = self._compile_address(self._in_nonblank())
                    if a2 is None:
                        raise self._bad(BAD_COMMA)
                    cmd.a2 = a2
                    ch = self._in_nonblank()
                if (
                    a1.kind == "num"
                    and a1.n == 0
                    and (
                        (cmd.a2 is None and ch != "r")
                        or (cmd.a2 is not None and cmd.a2.kind != "regex")
                    )
                ):
                    raise self._bad(INVALID_LINE_0)
            if ch == "!":
                cmd.bang = True
                ch = self._in_nonblank()
                if ch == "!":
                    raise self._bad(BAD_BANG)
            if ch is None:
                raise self._bad(NO_COMMAND)
            cmd.cmd = ch
            if self._compile_command(cmd, ch):
                self.commands.append(cmd)

    def _compile_command(self, cmd: SedCommand, ch: str) -> bool:
        """Compile the command letter ``ch``.

        Returns False for ``#`` and ``v``, which leave nothing in the
        program.

        Args:
            cmd (SedCommand): the command with its addresses.
            ch (str): the command letter.
        """
        if ch == "#":
            if cmd.a1 is not None:
                raise self._bad(NO_SHARP_ADDR)
            c = self._inchar()
            if (
                c == "n"
                and self.first_script
                and self.line < 2
                and self.pos == 2
            ):
                self.no_default_output = True
            while c is not None and c != "\n":
                c = self._inchar()
            return False
        if ch == "v":
            version = self._read_label()
            if _version_compare(version or "4.0", SED_VERSION) > 0:
                raise self._bad(ANCIENT_VERSION)
            return False
        if ch == "{":
            self.blocks.append((len(self.commands), self._block_where()))
            cmd.bang = not cmd.bang
            return True
        if ch == "}":
            if not self.blocks:
                raise self._bad(EXCESS_CLOSE_BRACE)
            if cmd.a1 is not None:
                raise self._bad(NO_CLOSE_BRACE_ADDR)
            self._read_end_of_cmd()
            index, _ = self.blocks.pop()
            self.commands[index].jump = len(self.commands)
            return True
        if ch == "e":
            raise self._bad(NO_EVAL)
        if ch in ("a", "i", "c"):
            c = self._in_nonblank()
            if c is None:
                raise self._bad(EXPECTED_SLASH)
            if c == "\\":
                c = self._inchar()
            else:
                self._savchar(c)
                c = "\n"
            self._read_text(cmd, c)
            return True
        if ch == ":":
            if cmd.a1 is not None:
                raise self._bad(NO_COLON_ADDR)
            label = self._read_label()
            if not label:
                raise self._bad(COLON_LACKS_LABEL)
            cmd.label = label
            self.labels[label] = len(self.commands)
            return True
        if ch in ("T", "b", "t"):
            cmd.label = self._read_label()
            self.jumps.append((len(self.commands), cmd.label))
            return True
        if ch in ("q", "Q", "l", "L"):
            if ch in ("q", "Q") and cmd.a2 is not None:
                raise self._bad(ONE_ADDR)
            c = self._in_nonblank()
            if _is_digit(c):
                cmd.int_arg = self._in_integer(c)
            else:
                cmd.int_arg = -1
                self._savchar(c)
            self._read_end_of_cmd()
            return True
        if ch in _SIMPLE:
            self._read_end_of_cmd()
            return True
        if ch == "r":
            name = self._read_filename()
            if not name:
                raise self._bad(MISSING_FILENAME)
            cmd.fname = name
            if name not in self.rfiles:
                self.rfiles.append(name)
            if (
                cmd.a1 is not None
                and cmd.a1.kind == "num"
                and cmd.a1.n == 0
                and cmd.a2 is None
            ):
                cmd.a1 = SedAddr("num", n=1)
                cmd.prepend = True
            return True
        if ch == "R":
            cmd.fname = self._open_file(False)
            return True
        if ch in ("w", "W"):
            cmd.fname = self._open_file(True)
            return True
        if ch == "s":
            slash = self._inchar()
            pattern = self._match_slash(slash, True)
            if pattern is None:
                raise self._bad(UNTERM_S_CMD)
            replacement = self._match_slash(slash, False)
            if replacement is None:
                raise self._bad(UNTERM_S_CMD)
            sub = SedSubst(
                re=None,
                replacement=self._normalize_text(
                    replacement, SedText.REPLACEMENT
                ),
            )
            icase, multiline = self._mark_subst_opts(sub)
            sub.re = self._regex(
                pattern, icase, multiline, _max_reference(replacement)
            )
            cmd.subst = sub
            return True
        if ch == "y":
            slash = self._inchar()
            src = self._match_slash(slash, False)
            if src is None:
                raise self._bad(UNTERM_Y_CMD)
            dst = self._match_slash(slash, False)
            if dst is None:
                raise self._bad(UNTERM_Y_CMD)
            cmd.y_src = list(self._normalize_text(src))
            cmd.y_dst = list(self._normalize_text(dst))
            if len(cmd.y_src) != len(cmd.y_dst):
                raise self._bad(Y_CMD_LEN)
            self._read_end_of_cmd()
            return True
        raise self._bad(
            f"unknown command: `{_first_byte(ch)}'", len(encode_text(ch)) - 1
        )

    def _check_final(self) -> None:
        if self.blocks:
            _, where = self.blocks[-1]
            raise SedError(
                f"sed: {where}: {EXCESS_OPEN_BRACE}", 1, self.wfiles
            )
        if self.pending_text is not None and self.old_text_cmd is not None:
            self.old_text_cmd.text = byte_view(self.pending_text) or None
            self.pending_text = None
        for index, label in self.jumps:
            target = self.labels.get(label)
            if target is not None:
                self.commands[index].jump = target
            elif label:
                raise SedError(
                    f"sed: can't find label for jump to `{label}'",
                    4,
                    self.wfiles,
                )
            else:
                self.commands[index].jump = len(self.commands)


def compile_script(
    pieces: Sequence[SedScriptPiece], extended: bool = False
) -> SedProgram:
    """Compile a sed script given as its -e and -f pieces, as GNU 4.9 does.

    Raises SedError with GNU's wording, ``sed: -e expression #N, char M:``
    or ``sed: file F line L:`` before the reason.

    Args:
        pieces (Sequence[SedScriptPiece]): the -e and -f pieces in order.
        extended (bool): -E, the POSIX extended syntax.
    """
    return _Compiler(extended).compile(pieces)


def looks_ahead(program: SedProgram) -> bool:
    """Whether the script ever asks if more input follows.

    GNU asks (``test_eof``) for a ``$`` address and for ``n`` and ``N``,
    and that lookahead passes over a directory to the operands after it;
    only a new cycle reads the directory and fails. So only a script that
    looks ahead needs the operands after a directory.

    Args:
        program (SedProgram): the compiled script.
    """
    return any(
        cmd.cmd in ("n", "N")
        or any(
            addr is not None and addr.kind == "last"
            for addr in (cmd.a1, cmd.a2)
        )
        for cmd in program.commands
    )


def _max_reference(replacement: str) -> int:
    """The highest group an ``s`` replacement names, 0 for none.

    Args:
        replacement (str): the replacement as read.
    """
    top = 0
    i = 0
    while i < len(replacement):
        if replacement[i] == "\\":
            nxt = replacement[i + 1 : i + 2]
            if nxt.isdigit() and nxt.isascii():
                top = max(top, int(nxt))
            i += 2
            continue
        i += 1
    return top


def _bracket_end(pattern: str, start: int) -> int:
    """The index just past the bracket expression opening at ``start``.

    Args:
        pattern (str): the regex.
        start (int): the index of the ``[``.
    """
    j = start + 1
    if pattern[j : j + 1] == "^":
        j += 1
    if pattern[j : j + 1] == "]":
        j += 1
    while j < len(pattern) and pattern[j] != "]":
        opener = pattern[j + 1 : j + 2]
        if pattern[j] == "[" and opener in (":", ".", "="):
            close = pattern.find(opener + "]", j + 2)
            j = len(pattern) if close < 0 else close + 2
        else:
            j += 1
    return j + 1


def _unmatched_close_paren(pattern: str) -> int:
    """Where an ERE's first ``)`` with no open group sits, or -1.

    Args:
        pattern (str): the regex.
    """
    depth = 0
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            i += 2
            continue
        if ch == "[":
            i = _bracket_end(pattern, i)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0:
                return i
            depth -= 1
        i += 1
    return -1


def _confusing_bracket(pattern: str) -> bool:
    """dfa.c's check for ``[:space:]`` written without its outer brackets.

    A bracket expression that starts and ends with ``:``, holds some
    other character, and has no range or class inside. glibc accepts it
    (as the set of those characters); GNU sed then refuses it.

    Args:
        pattern (str): the regex after the escape pre-pass.
    """
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "\\":
            i += 2
            continue
        if ch != "[":
            i += 1
            continue
        j = i + 1
        if pattern[j : j + 1] == "^":
            j += 1
        state = 1 if pattern[j : j + 1] == ":" else 0
        first = True
        while True:
            if j >= n:
                return False
            c = pattern[j]
            if c == "]" and not first:
                j += 1
                break
            first = False
            state &= ~2
            opener = pattern[j + 1 : j + 2]
            if c == "[" and opener in (":", ".", "="):
                k = j + 2
                while k < n and not (
                    pattern[k] == opener and pattern[k + 1 : k + 2] == "]"
                ):
                    k += 1
                j = k + 2
                state |= 8
                continue
            end = pattern[j + 2 : j + 3]
            if pattern[j + 1 : j + 2] == "-" and end and end != "]":
                state |= 8
                j += 3
                continue
            state |= 2 if c == ":" else 4
            j += 1
        if state == 7:
            return True
        i = j
    return False
