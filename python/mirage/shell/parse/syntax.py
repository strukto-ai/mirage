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

import logging
from collections.abc import Callable, Iterable
from typing import NoReturn

from mirage.io import IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse import constants
from mirage.shell.parse.errors import ReaderRefusal, TestFailure
from mirage.shell.parse.heredoc.delimiter import (
    clean_delimiter,
    delimiter_quoted,
    joined,
)
from mirage.shell.parse.heredoc.line import ends_escaped
from mirage.shell.parse.heredoc.types import HeredocPlan
from mirage.shell.parse.types import (
    ReaderHeredoc,
    ReaderState,
    ReaderToken,
    SyntaxDiagnostic,
)
from mirage.shell.types import TSNodeLike

logger = logging.getLogger(__name__)


def check_syntax(
    command: str,
    aliases: frozenset[str] = frozenset(),
    own: Callable[[str, int], bool] | None = None,
    extglob: bool = False,
) -> SyntaxDiagnostic | None:
    """Read a line as bash 5.2 does and report what it refuses.

    A lexer and a recursive-descent grammar written from POSIX's shell
    grammar, bash's manual and pinned bash behavior: they stop at the
    first token bash cannot take where it stands and name it as bash does.
    Status 2 is a syntax error. Status 1 is an array assignment bash cannot
    read; bash discards that line and reads on from the next, where a
    later error's status wins. Status 127 is a command or process
    substitution whose body bash cannot parse. A line nested deeper than
    the reader can go (``MAX_NESTING`` constructs, or the host's own
    stack) is refused, as bash refuses one nested past its reader.

    Args:
        command (str): the line, heredoc bodies and continuations included.
        aliases (frozenset[str]): alias names the shell would expand where a
            command starts; a closing reserved word among them is a command
            there.
        own (Callable[[str, int], bool] | None): whether an alias is in
            progress at a character of the original line.

    Returns:
        SyntaxDiagnostic | None: the text bash names, what it prints and
        its status; None when bash reads the line.
    """
    try:
        found = _LineReader(command, aliases, own, extglob).refusals()
    except RecursionError:
        logger.debug("line nested past the host's stack, refused")
        found = [
            ReaderRefusal(
                ["syntax error: nesting too deep"], 2, "", 0, 0, False
            )
        ]
    if not found:
        return None
    message = "".join(
        f"{_mirage_wording(line)}\n"
        for refusal in found
        for line in refusal.lines
    )
    return SyntaxDiagnostic(found[0].offending, message, found[-1].status)


def pattern_source(data: bytes) -> bytes:
    """Shield pattern operators while preserving expansions and byte spans.

    The syntax gate separately decides whether extglob is enabled. The
    structural parser always recognizes it, including the implicit mode
    on the right of a conditional comparison.

    Args:
        data (bytes): encoded shell source.
    """
    command = data.decode("utf-8", errors="surrogateescape")
    if not any(c + "(" in command for c in constants.EXTGLOB_OPENERS):
        return data
    reader = _LineReader(command, frozenset(), None, True)
    try:
        reader.refusals()
    except RecursionError:
        logger.debug("pattern source nested past the host's stack")
        return data
    out = list(command)
    for start, end in reader.patterns:
        out[start:end] = ":" * (end - start)
    return encode_text("".join(out))


def heredoc_plan(command: str) -> HeredocPlan | None:
    """The heredocs bash reads in a line: each one's ``<<`` and where its
    body starts and ends, in the order bash reads the bodies (those a
    substitution carries out first), and each substitution that closes
    with bodies still to read.

    Args:
        command (str): the line.

    Returns:
        HeredocPlan | None: offsets in UTF-8 bytes; None when bash refuses
        the line, whose heredocs nothing reads.
    """
    reader = _LineReader(command, frozenset(), None)
    try:
        if reader.refusals():
            return None
    except RecursionError:
        logger.debug("line nested past the host's stack, no heredoc plan")
        return None

    def byte(at: int) -> int:
        return len(encode_text(command[:at]))

    return HeredocPlan(
        tuple(
            (byte(at), byte(start), byte(end))
            for at, (start, end) in reader.bodies.items()
        ),
        tuple(
            (byte(close), tuple(byte(at) for at in opened))
            for close, opened in reader.closes
        ),
    )


def syntax_error_result(found: SyntaxDiagnostic) -> IOResult:
    """The result of a line that cannot run: its diagnostic and status.

    Args:
        found (SyntaxDiagnostic): what refused the line.
    """
    return IOResult(exit_code=found.status, stderr=encode_text(found.message))


def find_syntax_issue(node: TSNodeLike) -> SyntaxDiagnostic | None:
    """A structural error the grammar left in a line bash reads.

    ``check_syntax`` judges the line; this catches the lines it accepts
    that the grammar still cannot build a tree for, which mirage then has
    nothing to run for; it is worded as an unexpected token, status 2.
    Parameter syntax is judged as the word expands (a bad substitution),
    a ``[`` test's arguments by that builtin, and a ``$(...)`` body as the
    line it runs as; the words of an associative subscript may hold
    blanks, and the grammar recovers a ``for`` header's ``in`` as an
    error of its own, and the ``;`` it misses
    between a compound command and the reserved word closing around it
    (``{ { a; } }``) as a missing token.

    Args:
        node (TSNodeLike): root node from parse().
    """
    if node.type == "expansion" or not node.has_error:
        return None
    if node.type == "command_substitution" and (node.text or b"").startswith(
        b"$("
    ):
        return None
    if (
        node.type == "test_command"
        and node.children
        and node.children[0].type == "["
    ):
        return None
    for child in node.children:
        if (
            node.type == "subscript"
            and child.type == "ERROR"
            and child.children
            and all(
                part.type == "word" and not part.has_error
                for part in child.children
            )
        ):
            continue
        if child.is_missing and child.type != ";":
            return _issue(child)
        if (
            child.type == "ERROR"
            and _is_structural_error(child)
            and not (
                node.type == "for_statement"
                and (child.text or b"").strip() == b"in"
            )
        ):
            return _issue(child)
        if child.type != "ERROR":
            nested = find_syntax_issue(child)
            if nested is not None:
                return nested
    return None


def _issue(node: TSNodeLike) -> SyntaxDiagnostic:
    text = decode_text(node.text or b"")
    snippet = text.strip()
    message = (
        f"mirage: syntax error near '{snippet}'\n"
        if snippet
        else "mirage: syntax error in command\n"
    )
    return SyntaxDiagnostic(text, message)


def _is_structural_error(node: TSNodeLike) -> bool:
    """Whether an ERROR node holds a token that structures a line.

    Args:
        node (TSNodeLike): the ERROR node.
    """
    return any(
        child.is_named
        or child.type in constants.BASH_KEYWORDS
        or child.type in constants.STRUCTURAL_TOKENS
        or child.type in constants.SEPARATOR_TOKENS
        for child in node.children
    )


def _mirage_wording(line: str) -> str:
    """One of bash's diagnostic lines as mirage prints it.

    Args:
        line (str): the line in bash's words, without bash's prefix.
    """
    for opener in (
        "syntax error near unexpected token `",
        "syntax error near `",
    ):
        if line.startswith(opener) and line.endswith("'"):
            return f"mirage: syntax error near '{line[len(opener) : -1]}'"
    return f"mirage: {line}"


def _is_name(text: str) -> bool:
    return (
        bool(text)
        and text[0] in constants.NAME_START
        and all(c in constants.NAME_CHARS for c in text)
    )


def _closes_substitution(rest: str) -> bool:
    """Whether a heredoc line's text after its delimiter holds an unquoted
    ``)``: inside a substitution, such a line ends the document there.

    Args:
        rest (str): the line after the delimiter.
    """
    quote = ""
    i = 0
    while i < len(rest):
        c = rest[i]
        if quote:
            if c == "\\" and quote == '"':
                i += 1
            elif c == quote:
                quote = ""
        elif c in "'\"":
            quote = c
        elif c == "\\":
            i += 1
        elif c == ")":
            return True
        i += 1
    return False


def _semicolons(body: str) -> int:
    """How many expressions an arithmetic ``for`` header's ``;`` divide.

    Args:
        body (str): the text between ``((`` and ``))``.
    """
    count = depth = 0
    quote = ""
    i = 0
    while i < len(body):
        c = body[i]
        if quote:
            if c == "\\" and quote != "'":
                i += 1
            elif c == quote:
                quote = ""
        elif c in "'\"`":
            quote = c
        elif c == "\\":
            i += 1
        elif body.startswith("${", i):
            close = body.find("}", i)
            i = len(body) if close < 0 else close
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == ";" and depth == 0:
            count += 1
        i += 1
    return count


def _test_text(tok: ReaderToken) -> str:
    if tok.kind == "newline":
        return "newline"
    if tok.kind == "eof":
        return "EOF"
    return tok.text


def _is_test_close(tok: ReaderToken) -> bool:
    return tok.kind == "word" and tok.plain and tok.text == "]]"


class _LineReader:
    """bash's reader over one line: a lexer whose modes the grammar sets.

    The line is read as bash reads its input: a newline ends the input if
    none does, a trailing backslash quotes the end of it, and each heredoc
    body is skipped after the newline that ends its command. ``frames``
    tracks the arrays and substitutions being read, which decide the
    status of an error inside them; ``bodies`` and ``closes`` keep the
    heredoc plan (see ``heredoc_plan``).

    Args:
        text (str): the line.
        aliases (frozenset[str]): as in ``check_syntax``.
        own (Callable[[str, int], bool] | None): as in ``check_syntax``.
    """

    def __init__(
        self,
        text: str,
        aliases: frozenset[str],
        own: Callable[[str, int], bool] | None,
        extglob: bool = False,
    ) -> None:
        self.text = text
        self.n = len(text)
        self.quoted_end = ends_escaped(text)
        self.aliases = aliases
        self.own = own
        self.extglob = extglob
        self.patterns: list[tuple[int, int]] = []
        self.subs: dict[
            tuple[int, int | None], tuple[int, tuple[ReaderHeredoc, ...]]
        ] = {}
        self.bodies: dict[int, tuple[int, int]] = {}
        self.closes: list[tuple[int, tuple[int, ...]]] = []
        self.warned: set[int] = set()
        self.reset(0)

    def reset(self, pos: int) -> None:
        self.pos = pos
        self.ended = self.quoted_end or self.text.endswith("\n")
        self.limit: int | None = None
        self.floor = 0
        self.frames: list[str] = []
        self.heredocs: tuple[ReaderHeredoc, ...] = ()
        self.carried = 0
        self.peeked: tuple[int, int, ReaderToken] | None = None
        self.after = False
        self.matching = False
        self.depth = 0
        self.nesting = 0
        self.braces = 0

    def refusals(self) -> list[ReaderRefusal]:
        """Every error bash reports for the line, in order.

        An array bash cannot read discards the rest of its line only, so
        the next line is read on; an end of input inside a quote then
        leaves the status as it was.
        """
        found: list[ReaderRefusal] = []
        while True:
            try:
                self.program()
                return found
            except ReaderRefusal as refusal:
                if found and self.matching:
                    refusal.status = found[-1].status
                found.append(refusal)
                if refusal.status != 1 or refusal.eof:
                    return found
                nxt = self.text.find("\n", refusal.end, self.n)
                if nxt < 0:
                    return found
                self.reset(nxt + 1)

    # -- refusals -------------------------------------------------------

    def status(self, eof: bool) -> int:
        """The status of an error here: 1 inside an array (for the end of
        input, inside any), else 127 inside a substitution, else 2.

        Args:
            eof (bool): the input ended inside a construct.
        """
        if eof:
            return 1 if "array" in self.frames else 2
        if not self.frames:
            return 2
        return 1 if self.frames[-1] == "array" else 127

    def refuse(
        self, lines: list[str], eof: bool, offending: str, start: int, end: int
    ) -> NoReturn:
        raise ReaderRefusal(
            lines, self.status(eof), offending, start, end, eof
        )

    def fail_token(self, tok: ReaderToken) -> NoReturn:
        """Refuse the line at a token bash cannot take where it stands.

        Args:
            tok (ReaderToken): the token.
        """
        if tok.kind == "eof":
            self.fail_eof()
        if tok.kind == "redirvar":
            start, end = self.near_span(tok.end + 1)
            word = self.text[start:end]
            self.refuse(
                [f"syntax error near `{word}'"], False, word, start, end
            )
        if tok.kind == "newline":
            text = "newline"
        elif tok.kind == "arith":
            text = tok.text[2:-2]
        else:
            text = tok.text
            if self.quoted_end and tok.end >= self.n and text.endswith("\\"):
                text += "\\"
        self.refuse(
            [f"syntax error near unexpected token `{text}'"],
            False,
            text,
            tok.start,
            tok.end,
        )

    def fail_match(self, closer: str, at: int) -> NoReturn:
        """Refuse a line that ends inside a quote or expansion.

        Args:
            closer (str): the character bash was looking for.
            at (int): where the construct opens.
        """
        self.matching = True
        self.refuse(
            [f"unexpected EOF while looking for matching `{closer}'"],
            True,
            "",
            at,
            at,
        )

    def fail_eof(self) -> NoReturn:
        if self.limit is not None:
            self.fail_near(self.limit)
        self.refuse([self.eof_line()], True, "", self.n, self.n)

    def eof_line(self) -> str:
        if "sub" in self.frames:
            return "unexpected EOF while looking for matching `)'"
        return "syntax error: unexpected end of file"

    def near_span(self, at: int) -> tuple[int, int]:
        """Where the text bash quotes back from where its reader stopped
        lies: back over blanks, then to a blank or past one of ``;&|``.

        Args:
            at (int): where the reader stopped.
        """
        text = self.text
        end = min(at, self.n)
        while end > self.floor and text[end - 1] in " \t\n":
            end -= 1
        start = end
        while start > self.floor:
            c = text[start - 1]
            if c in " \t\n":
                break
            start -= 1
            if c in constants.NEAR_TEXT_STOPS:
                break
        return start, end

    def fail_near(self, at: int, eof: bool = True) -> NoReturn:
        """Refuse the line with bash's ``syntax error near `X'``, the text
        quoted back from ``at``.

        Args:
            at (int): where the reader stopped.
            eof (bool): the status is the end of input's (1 in an array,
                else 2) rather than the token's.
        """
        self.limit = None
        self.floor = 0
        start, end = self.near_span(at)
        if start == end:
            self.fail_eof()
        word = self.text[start:end]
        self.refuse([f"syntax error near `{word}'"], eof, word, start, end)

    # -- quotes and expansions --------------------------------------------

    def single_quote(self, i: int) -> int:
        k = self.text.find("'", i + 1, self.n)
        if k < 0:
            self.fail_match("'", i)
        return k + 1

    def ansi_quote(self, i: int) -> int:
        text, n = self.text, self.n
        j = i + 1
        while j < n:
            c = text[j]
            if c == "\\":
                j += 2
            elif c == "'":
                return j + 1
            else:
                j += 1
        self.fail_match("'", i)
        return j

    def double_quote(self, i: int) -> int:
        text, n = self.text, self.n
        j = i + 1
        while j < n:
            c = text[j]
            if c == '"':
                return j + 1
            if c == "\\":
                j += 2
            elif c == "`":
                j = self.backtick(j)
            elif c == "$":
                j = self.dollar(j, True)
            else:
                j += 1
        self.fail_match('"', i)
        return j

    def backtick(self, i: int) -> int:
        """Skip a backquoted substitution, whose body bash parses only
        when it runs.

        Args:
            i (int): the opening backquote.
        """
        text, n = self.text, self.n
        j = i + 1
        while j < n:
            c = text[j]
            if c == "\\":
                j += 2
            elif c == "`":
                return j + 1
            else:
                j += 1
        self.fail_match("`", i)
        return j

    def dollar(self, i: int, quoted: bool) -> int:
        """Skip what a ``$`` opens: a substitution (parsed), arithmetic, an
        expansion or a quote.

        ``$((`` is arithmetic when its parentheses close as ``))``, else a
        substitution matched as text. Inside double quotes ``$'`` and
        ``$"`` open nothing.

        Args:
            i (int): the ``$``.
            quoted (bool): inside double quotes.
        """
        text = self.text
        at = joined(self.text, i + 1)
        nxt = text[at : at + 1]
        if nxt == "$":
            return at + 1
        if nxt == "(":
            inner = joined(self.text, at + 1)
            if text[inner : inner + 1] == "(":
                end = self.matched(inner + 1, i)
                if text[end + 1 : end + 2] == ")":
                    return end + 2
                return self.matched(at + 1, i) + 1
            return self.substitution(i, at + 1)
        if nxt == "{":
            return self.brace(at + 1, i)
        if nxt == "[":
            return self.matched(at + 1, i, "[", "]") + 1
        if not quoted and nxt == "'":
            return self.ansi_quote(at)
        if not quoted and nxt == '"':
            return self.double_quote(at)
        return i + 1

    def word_char(self, j: int) -> int:
        c = self.text[j]
        if c == "\\":
            return j + 2
        if c == "'":
            return self.single_quote(j)
        if c == '"':
            return self.double_quote(j)
        if c == "`":
            return self.backtick(j)
        if c == "$":
            return self.dollar(j, False)
        return j + 1

    def process_substitution(self, i: int) -> int:
        """Skip ``<(`` or ``>(``: parsed, unless ``((`` follows, which bash
        matches as text.

        Args:
            i (int): the ``<`` or ``>``.
        """
        at = joined(self.text, i + 1)
        if self.char_at(at + 1) == "(":
            return self.matched(at + 1, i) + 1
        return self.substitution(i, at + 1)

    def extended_pattern(self, i: int) -> int:
        """Read a pattern group, shielding only its literal syntax.

        Args:
            i (int): the extended pattern's operator.
        """
        self.patterns.append((i, i + 2))
        j, depth = i + 2, 1
        while j < self.n:
            c = self.text[j]
            if c in "'\"`$\\":
                j = self.word_char(j)
                continue
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            if c in "()| \t\n;&<>" or (
                c in constants.EXTGLOB_OPENERS
                and self.text[j + 1 : j + 2] == "("
            ):
                self.patterns.append((j, j + 1))
            j += 1
            if depth == 0:
                return j
        self.fail_match(")", i + 1)

    def brace(self, j: int, opened: int) -> int:
        """Skip an expansion's ``${...}``: the first unquoted ``}`` closes it.

        Args:
            j (int): just past ``${``.
            opened (int): the ``$``.
        """
        text, n = self.text, self.n
        while j < n:
            c = text[j]
            if c == "}":
                return j + 1
            if c in "<>" and self.char_at(j + 1) == "(":
                j = self.process_substitution(j)
                continue
            j = self.word_char(j)
        self.fail_match("}", opened)
        return j

    def bracket(self, j: int, opened: int) -> int:
        """Skip a subscript up to its ``]``, nested brackets and blanks
        included.

        Args:
            j (int): just past ``[``.
            opened (int): the ``[``.
        """
        text, n = self.text, self.n
        depth = 1
        while j < n:
            c = text[j]
            if c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    return j + 1
            j = self.word_char(j)
        self.fail_match("]", opened)
        return j

    def matched(
        self, j: int, opened: int, left: str = "(", right: str = ")"
    ) -> int:
        """The index of the closer matching an opener, read as text: quotes
        and a ``$(`` substitution are skipped, any other expansion is text.

        Args:
            j (int): just past the opener.
            opened (int): where the construct opens.
            left (str): the opener.
            right (str): the closer.
        """
        text, n = self.text, self.n
        depth = 1
        while j < n:
            c = text[j]
            if c == right:
                depth -= 1
                if depth == 0:
                    return j
                j += 1
            elif c == left:
                depth += 1
                j += 1
            elif c == "\\":
                j += 2
            elif c == "'":
                j = self.single_quote(j)
            elif c == '"':
                j = self.double_quote(j)
            elif c == "`":
                j = self.backtick(j)
            elif c == "$" and self.char_at(j + 1) == "(":
                j = self.dollar(j, False)
            else:
                j += 1
        self.fail_match(right, opened)
        return j

    # -- nested reads -------------------------------------------------------

    def save(self) -> ReaderState:
        return (self.pos, self.peeked, self.heredocs, self.carried, self.after)

    def restore(self, state: ReaderState) -> None:
        self.pos, self.peeked, self.heredocs, self.carried, self.after = state

    def substitution(self, opened: int, j: int) -> int:
        """Parse a substitution's command list; the index past its ``)``.

        Heredocs opened inside and still pending at its ``)`` read their
        bodies after the line's next newline. A body read once is not read
        again when its word is.

        Args:
            opened (int): the ``$``, ``<`` or ``>``.
            j (int): just past the ``(``.
        """
        known = self.subs.get((j, self.limit))
        if known is not None:
            self.pend(known[1], carried=True)
            return known[0]
        if self.nesting >= constants.MAX_NESTING:
            opener = self.text[opened:j].replace("\\\n", "")
            self.fail_token(ReaderToken("op", opener, opened, j))
        state = self.save()
        self.pos, self.peeked = j, None
        self.heredocs, self.carried = (), 0
        self.frames.append("sub")
        self.nesting += 1
        self.linebreak()
        while True:
            tok = self.peek(constants.READ_COMMAND)
            if tok.kind == "op" and tok.text == ")":
                break
            if tok.kind == "eof":
                self.refuse([self.eof_line()], True, "", j, j)
            self.and_or()
            tok = self.peek_after()
            if tok.kind == "op" and tok.text in (";", "&"):
                self.take(tok)
                self.linebreak()
            elif tok.kind == "newline":
                self.linebreak()
            elif tok.kind == "op" and tok.text == ")":
                break
            else:
                self.fail_token(tok)
        self.nesting -= 1
        self.frames.pop()
        pending: tuple[ReaderHeredoc, ...] = self.heredocs
        fresh = tuple(h.at for h in pending if h.at not in self.warned)
        if fresh:
            self.closes.append((tok.start, fresh))
            self.warned.update(fresh)
        self.restore(state)
        self.pend(pending, carried=True)
        self.subs[(j, self.limit)] = (tok.end, pending)
        return tok.end

    def array(self, i: int, mode: int) -> int:
        """Read an array assignment's words; the index past its ``)``.

        Only words and newlines may stand inside: any other token is the
        error, status 1. A newline inside reads the heredoc bodies pending
        there, which bash reads again after the array; heredocs opened
        inside and pending at its ``)`` read theirs after it.

        Args:
            i (int): the ``(``.
            mode (int): the assignment's ``READ_*`` flags: with
                ``READ_BODY`` the array stands where a function body must,
                so a reserved word inside is one; with ``READ_KEYS`` an
                element's ``name[`` reads a subscript.
        """
        state = self.save()
        self.pos, self.peeked = i + 1, None
        self.frames.append("array")
        element = constants.READ_ELEMENT | (
            constants.READ_SUBSCRIPTS if mode & constants.READ_KEYS else 0
        )
        while True:
            tok = self.peek(element)
            if (
                mode & constants.READ_BODY
                and tok.kind == "word"
                and tok.plain
                and tok.text in constants.RESERVED_WORDS
            ):
                self.fail_token(tok)
            if tok.kind in ("newline", "word"):
                self.take(tok)
                continue
            if tok.kind == "op" and tok.text == ")":
                break
            if tok.kind == "eof":
                self.fail_match(")", i)
            self.fail_token(tok)
        self.frames.pop()
        opened = [heredoc for heredoc in self.heredocs if heredoc.at > i]
        self.restore(state)
        self.pend(opened, carried=True)
        return tok.end

    # -- tokens ---------------------------------------------------------------

    def blank_end(self, i: int) -> int:
        text, n = self.text, self.n
        while i < n:
            if text[i] in " \t":
                i += 1
            elif text.startswith("\\\n", i):
                i += 2
            else:
                break
        return i

    def operator(self, i: int) -> tuple[str, int] | None:
        """The operator at ``i``, continued lines joined, and its end.

        Args:
            i (int): where the token starts.
        """
        text = self.text
        chars: list[str] = []
        ends: list[int] = []
        j = i
        while len(chars) < 3 and j < self.n:
            if text.startswith("\\\n", j):
                j += 2
                continue
            if text[j] not in constants.OPERATOR_CHARS:
                break
            chars.append(text[j])
            j += 1
            ends.append(j)
        spelled = "".join(chars)
        for op in constants.OPERATORS:
            if spelled.startswith(op):
                return op, ends[len(op) - 1]
        return None

    def peek(self, mode: int = 0) -> ReaderToken:
        """The next token, read in ``mode``, without taking it.

        Args:
            mode (int): the ``READ_*`` flags.
        """
        if (
            self.peeked is not None
            and self.peeked[0] == self.pos
            and self.peeked[1] == mode
        ):
            return self.peeked[2]
        tok = self.lex(self.pos, mode)
        self.peeked = (self.pos, mode, tok)
        return tok

    def peek_after(self) -> ReaderToken:
        """The token after a command. After a compound one it is read as
        where a command starts: reserved words, arrays and arithmetic."""
        return self.peek(constants.READ_FOLLOW if self.after else 0)

    def take(self, tok: ReaderToken) -> None:
        self.peeked = None
        self.pos = tok.end
        if tok.kind == "newline":
            if tok.start == tok.end:
                self.ended = True
            if self.heredocs:
                self.pos = self.heredoc_bodies(tok.end)

    def heredoc_bodies(self, i: int) -> int:
        """Skip the bodies of the heredocs pending at a newline.

        A body ends at the line equal to its delimiter, leading tabs
        stripped for ``<<-``, and continued lines joined unless the
        delimiter was quoted. Inside a substitution a line that opens with
        the delimiter and has an unquoted ``)`` after it ends the body
        there too.

        Args:
            i (int): just past the newline.
        """
        text, n = self.text, self.n
        nested = "sub" in self.frames
        for at, delimiter, strip, quoted in self.heredocs:
            start = i
            while i < n:
                end = text.find("\n", i, n)
                end = n if end < 0 else end
                line = text[i:end]
                while not quoted and end < n and ends_escaped(line):
                    nxt = text.find("\n", end + 1, n)
                    nxt = n if nxt < 0 else nxt
                    line = line[:-1] + text[end + 1 : nxt]
                    end = nxt
                body = line.lstrip("\t") if strip else line
                if body == delimiter:
                    i = min(end + 1, n)
                    break
                if (
                    nested
                    and body.startswith(delimiter)
                    and _closes_substitution(body[len(delimiter) :])
                ):
                    resume = i + len(line) - len(body) + len(delimiter)
                    self.bodies.setdefault(at, (start, resume))
                    self.heredocs, self.carried = (), 0
                    return resume
                i = min(end + 1, n)
            self.bodies.setdefault(at, (start, i))
        self.heredocs, self.carried = (), 0
        return i

    def pend(
        self, heredocs: Iterable[ReaderHeredoc], carried: bool = False
    ) -> None:
        """Add heredocs whose bodies the next newline reads, each once: a
        word read again in another mode opens the same ones again. bash
        reads the ones carried out of a substitution first, in the order
        their substitutions close, then the ones opened directly.

        Args:
            heredocs (Iterable[ReaderHeredoc]): the heredocs, by where they open.
            carried (bool): they come out of a substitution.
        """
        known = {heredoc.at for heredoc in self.heredocs}
        new = tuple(h for h in heredocs if h.at not in known)
        if not carried:
            self.heredocs += new
            return
        at = self.carried
        self.heredocs = self.heredocs[:at] + new + self.heredocs[at:]
        self.carried += len(new)

    def char_at(self, i: int) -> str:
        """The character at ``i`` once continued lines are joined, or ``''``
        at the end of the line.

        Args:
            i (int): where to look.
        """
        i = joined(self.text, i)
        return self.text[i : i + 1]

    def lex(self, i: int, mode: int) -> ReaderToken:
        """Read the token at ``i``.

        Args:
            i (int): where to read.
            mode (int): the ``READ_*`` flags.
        """
        text, n = self.text, self.n
        while True:
            i = self.blank_end(i)
            if i < n and text[i] == "#":
                end = text.find("\n", i, n)
                i = n if end < 0 else end
                continue
            break
        if self.limit is not None and i >= self.limit:
            return ReaderToken("eof", "", i, i)
        if i >= n:
            if self.ended:
                return ReaderToken("eof", "", n, n)
            return ReaderToken("newline", "\n", n, n)
        c = text[i]
        if c == "\n":
            return ReaderToken("newline", "\n", i, i + 1)
        if mode & constants.READ_ARITH and text.startswith("((", i):
            return self.arith_command(i, bool(mode & constants.READ_START))
        if c in "<>" and self.char_at(i + 1) == "(":
            return self.word(i, 0)
        op = self.operator(i)
        if op is not None:
            return ReaderToken("op", op[0], i, op[1])
        if c == "{" and not mode & constants.READ_TEST:
            close = text.find("}", i, n)
            if (
                close > i
                and _is_name(text[i + 1 : close])
                and text[close + 1 : close + 2] in ("<", ">")
                and text[close + 2 : close + 3] != "("
            ):
                return ReaderToken(
                    "redirvar", text[i : close + 1], i, close + 1
                )
        if c.isdigit() and not mode & constants.READ_TEST:
            j = i
            while j < n and text[j].isdigit():
                j += 1
            if j < n and text[j] in "<>" and text[j + 1 : j + 2] != "(":
                return ReaderToken("number", text[i:j], i, j)
        return self.word(i, mode)

    def word(self, i: int, mode: int) -> ReaderToken:
        """Read a word, and the assignment or array it may open.

        Args:
            i (int): where it starts.
            mode (int): the ``READ_*`` flags.
        """
        text, n = self.text, self.n
        start = i
        plain = True
        state = "start" if mode & constants.READ_PREFIX else "none"
        assign = False
        if mode & constants.READ_ELEMENT and text[i] == "[":
            i = self.bracket(i + 1, i)
            plain = False
        while i < n:
            if self.limit is not None and i >= self.limit:
                break
            c = text[i]
            if c == "\\":
                if text.startswith("\n", i + 1):
                    i += 2
                    continue
                plain = False
                state = "none"
                i += 2
                continue
            if (
                self.extglob
                and c in constants.EXTGLOB_OPENERS
                and text[i + 1 : i + 2] == "("
            ):
                i = self.extended_pattern(i)
                plain = False
                state = "none"
                continue
            if c in constants.WORD_BREAKS:
                if c in "<>" and self.char_at(i + 1) == "(":
                    i = self.process_substitution(i)
                    plain = False
                    state = "none"
                    continue
                break
            if state in ("start", "name"):
                if c in constants.NAME_START or (
                    state == "name" and c in constants.NAME_CHARS
                ):
                    state = "name"
                elif state == "name" and c == "[":
                    end = (
                        self.bracket(i + 1, i)
                        if mode & constants.READ_SUBSCRIPTS
                        else self.subscript_end(i)
                    )
                    if end is not None:
                        i = end
                        state = "subscript"
                        plain = False
                        continue
                    state = "none"
                elif state == "name" and (
                    c == "=" or (c == "+" and self.char_at(i + 1) == "=")
                ):
                    state = "equals"
                else:
                    state = "none"
            elif state == "subscript":
                state = (
                    "equals"
                    if c == "=" or (c == "+" and self.char_at(i + 1) == "=")
                    else "none"
                )
            if state == "equals":
                assign = True
                state = "none"
                i = (i if c == "=" else joined(self.text, i + 1)) + 1
                opener = joined(self.text, i)
                if (
                    mode & constants.READ_ARRAYS
                    and text[opener : opener + 1] == "("
                ):
                    i = self.array(opener, mode)
                    plain = False
                continue
            if c in "'\"`$":
                plain = False
                state = "none"
            i = self.word_char(i)
        return ReaderToken(
            "word",
            text[start:i].replace("\\\n", ""),
            start,
            i,
            plain,
            assign,
        )

    def subscript_end(self, i: int) -> int | None:
        """Where a subscript in an argument closes, if it does before the
        word ends: only a prefix's subscript may hold blanks.

        Args:
            i (int): the ``[``.
        """
        text, n = self.text, self.n
        j = i + 1
        while j < n and text[j] not in constants.WORD_BREAKS:
            if text[j] == "]":
                return j + 1
            j += 1
        return None

    def arith_command(self, i: int, start: bool) -> ReaderToken:
        """Read ``((`` as arithmetic, or as the ``(`` of a subshell when it
        does not close as ``))``.

        Where a command starts, arithmetic that does not close on its line
        is read again as two subshells up to that point, and running out
        there is bash's ``syntax error near `X'``.

        Args:
            i (int): the first ``(``.
            start (bool): a command starts here.
        """
        text = self.text
        end = self.matched(i + 2, i)
        if text[end + 1 : end + 2] == ")":
            return ReaderToken("arith", text[i : end + 2], i, end + 2)
        if start and (end + 1 >= self.n or text[end + 1] == "\n"):
            if self.nesting >= constants.MAX_NESTING:
                self.fail_token(ReaderToken("op", "(", i, i + 1))
            self.nesting += 1
            state = self.save()
            outer = (self.limit, self.floor)
            self.limit, self.floor = end + 1, i + 1
            self.pos, self.peeked = i + 1, None
            try:
                self.compound_list(ops=frozenset({")"}))
            finally:
                self.limit, self.floor = outer
                self.restore(state)
            self.fail_near(end + 1)
        return ReaderToken("op", "(", i, i + 1)

    # -- grammar ------------------------------------------------------------

    def keyword(self, tok: ReaderToken) -> str | None:
        """The reserved word a token is where a command starts, if any.

        A closing word an alias spells is a command, except inside that
        alias's own text and inside a substitution.

        Args:
            tok (ReaderToken): the token.
        """
        if (
            tok.kind != "word"
            or not tok.plain
            or tok.text not in constants.RESERVED_WORDS
        ):
            return None
        if (
            tok.text in constants.CLOSING_WORDS
            and tok.text in self.aliases
            and "sub" not in self.frames
        ):
            if self.own is None or not self.own(tok.text, tok.start):
                return None
        return tok.text

    def linebreak(self) -> None:
        while (tok := self.peek()).kind == "newline":
            self.take(tok)

    def program(self) -> None:
        self.linebreak()
        while True:
            tok = self.peek(constants.READ_COMMAND)
            if tok.kind == "eof":
                return
            self.and_or()
            tok = self.peek_after()
            if tok.kind == "op" and tok.text in (";", "&"):
                self.take(tok)
                self.linebreak()
            elif tok.kind == "newline":
                self.linebreak()
            elif tok.kind != "eof":
                self.fail_token(tok)

    def stops(
        self, tok: ReaderToken, words: frozenset[str], ops: frozenset[str]
    ) -> bool:
        if tok.kind == "op":
            return tok.text in ops
        return self.keyword(tok) in words

    def compound_list(
        self,
        words: frozenset[str] = frozenset(),
        ops: frozenset[str] = frozenset(),
        empty: bool = False,
    ) -> ReaderToken:
        """Parse commands up to a closing word or operator; return it.

        Args:
            words (frozenset[str]): the reserved words that end the list.
            ops (frozenset[str]): the operators that end it.
            empty (bool): the list may hold no command (a case item).
        """
        self.linebreak()
        seen = False
        while True:
            tok = self.peek(constants.READ_COMMAND)
            if self.stops(tok, words, ops):
                if not seen and not empty:
                    self.fail_token(tok)
                return tok
            if tok.kind == "eof":
                self.fail_eof()
            self.and_or()
            seen = True
            tok = self.peek_after()
            if tok.kind == "op" and tok.text in (";", "&"):
                self.take(tok)
                self.linebreak()
            elif tok.kind == "newline":
                self.linebreak()
            elif not self.stops(tok, words, ops):
                self.fail_token(tok)

    def and_or(self) -> None:
        self.pipeline()
        while (tok := self.peek_after()).kind == "op" and tok.text in (
            "&&",
            "||",
        ):
            self.take(tok)
            self.linebreak()
            self.pipeline()

    def pipeline(self) -> None:
        """Parse a pipeline. ``time`` and ``!`` may lead it, with nothing
        after them before ``;`` or a newline; ``time`` takes an unquoted
        ``-p`` and then ``--``. After a ``|`` neither is a prefix (``time``
        is a command there, ``!`` an error)."""
        prefixed = False
        while True:
            tok = self.peek(constants.READ_COMMAND)
            word = self.keyword(tok)
            if word == "time":
                self.take(tok)
                for option in ("-p", "--"):
                    nxt = self.peek()
                    if nxt.kind == "word" and nxt.plain and nxt.text == option:
                        self.take(nxt)
            elif word == "!":
                self.take(tok)
            else:
                break
            prefixed = True
        if prefixed:
            tok = self.peek(constants.READ_COMMAND)
            if tok.kind in ("newline", "eof") or (
                tok.kind == "op" and tok.text == ";"
            ):
                self.after = False
                return
        self.command(False)
        while (tok := self.peek_after()).kind == "op" and tok.text in (
            "|",
            "|&",
        ):
            self.take(tok)
            self.linebreak()
            self.command(True)

    def command(self, piped: bool) -> None:
        """Parse one command where a command starts.

        Args:
            piped (bool): it follows a ``|``, where ``time`` is a command.
        """
        tok = self.peek(constants.READ_COMMAND)
        word = self.keyword(tok)
        if piped and word == "time":
            word = None
        if word is not None:
            if word not in constants.COMPOUND_OPENERS and word not in (
                "function",
                "coproc",
            ):
                self.fail_token(tok)
            self.compound(tok)
            self.redirects()
            return
        if tok.kind == "arith" or (tok.kind == "op" and tok.text == "("):
            self.compound(tok)
            self.redirects()
            return
        if tok.kind in ("word", "number", "redirvar") or (
            tok.kind == "op" and tok.text in constants.REDIRECTIONS
        ):
            self.simple()
            return
        self.fail_token(tok)

    def compound(self, tok: ReaderToken) -> None:
        """Parse a compound command, a function definition or a coproc;
        one nested ``MAX_NESTING`` deep is refused at its opener.

        Args:
            tok (ReaderToken): the token it opens with.
        """
        if self.nesting >= constants.MAX_NESTING:
            self.fail_token(tok)
        self.nesting += 1
        word = self.keyword(tok)
        if tok.kind == "arith":
            self.take(tok)
        elif tok.kind == "op" and tok.text == "(":
            self.take(tok)
            self.take(self.compound_list(ops=frozenset({")"})))
        elif word == "{":
            self.take(tok)
            self.braces += 1
            self.take(self.compound_list(words=frozenset({"}"})))
            self.braces -= 1
        elif word == "if":
            self.if_clause(tok)
        elif word in ("while", "until"):
            self.take(tok)
            self.take(self.compound_list(words=frozenset({"do"})))
            self.take(self.compound_list(words=frozenset({"done"})))
        elif word in ("for", "select"):
            self.for_clause(tok)
        elif word == "case":
            self.case_clause(tok)
        elif word == "[[":
            self.conditional(tok)
        elif word == "function":
            self.function(tok)
        elif word == "coproc":
            self.coproc(tok)
        else:
            self.fail_token(tok)
        self.nesting -= 1
        if word not in ("function", "coproc"):
            self.after = True

    def redirects(self) -> None:
        while True:
            tok = self.peek_after()
            if tok.kind in ("number", "redirvar") or (
                tok.kind == "op" and tok.text in constants.REDIRECTIONS
            ):
                self.redirect(tok)
                self.after = False
            else:
                return

    def redirect(self, tok: ReaderToken) -> None:
        """Parse a redirection: its operator and target word.

        Args:
            tok (ReaderToken): its descriptor or operator.
        """
        if tok.kind in ("number", "redirvar"):
            self.take(tok)
            tok = self.peek()
        self.take(tok)
        target = self.peek()
        if target.kind == "number" and tok.text in ("<&", ">&"):
            target = target._replace(kind="word")
        if target.kind != "word":
            self.fail_token(target)
        self.take(target)
        if tok.text in ("<<", "<<-"):
            word = self.text[target.start : target.end]
            self.pend(
                (
                    ReaderHeredoc(
                        tok.start,
                        clean_delimiter(word),
                        tok.text == "<<-",
                        delimiter_quoted(word),
                    ),
                )
            )

    def simple(self) -> None:
        """Parse a simple command, or a function definition ``name ()``.

        Assignments and redirections may lead it. An array stays an array
        through them until a redirection follows an assignment, and the
        first one after a redirection reads its elements' subscripts; the
        arguments of ``declare`` and its kin read arrays too, until a
        redirection.
        """
        self.after = False
        mode = constants.READ_PREFIX
        assigned = False
        prefixed = False
        while True:
            tok = self.peek(mode)
            if tok.kind in ("number", "redirvar") or (
                tok.kind == "op" and tok.text in constants.REDIRECTIONS
            ):
                self.redirect(tok)
                mode = (
                    0
                    if assigned
                    else constants.READ_PREFIX | constants.READ_KEYS
                )
                prefixed = True
            elif tok.kind == "word" and tok.assign:
                self.take(tok)
                mode &= ~constants.READ_KEYS
                assigned = prefixed = True
            else:
                break
        if tok.kind == "word":
            self.take(tok)
            if not prefixed:
                nxt = self.peek()
                if nxt.kind == "op" and nxt.text == "(":
                    self.take(nxt)
                    close = self.peek(constants.READ_FOLLOW)
                    if not (close.kind == "op" and close.text == ")"):
                        self.fail_token(close)
                    self.take(close)
                    self.linebreak()
                    self.function_body()
                    return
            mode = (
                constants.READ_ARRAYS
                if tok.plain and tok.text in constants.ARRAY_BUILTINS
                else 0
            )
            while True:
                tok = self.peek(mode)
                if tok.kind == "word":
                    self.take(tok)
                elif tok.kind in ("number", "redirvar") or (
                    tok.kind == "op" and tok.text in constants.REDIRECTIONS
                ):
                    self.redirect(tok)
                    mode = 0
                else:
                    break
        if tok.kind == "op" and tok.text == "(":
            self.fail_token(tok)

    def function_body(self) -> None:
        tok = self.peek(constants.READ_COMMAND | constants.READ_BODY)
        word = self.keyword(tok)
        if (
            (word is not None and word in constants.COMPOUND_OPENERS)
            or tok.kind == "arith"
            or (tok.kind == "op" and tok.text == "(")
        ):
            self.compound(tok)
            self.redirects()
            return
        self.fail_token(tok)

    def function(self, tok: ReaderToken) -> None:
        """Parse ``function NAME [()] body``; a ``(`` not followed by
        ``)`` opens a subshell body.

        Args:
            tok (ReaderToken): the ``function`` word.
        """
        self.take(tok)
        name = self.peek()
        if name.kind != "word":
            self.fail_token(name)
        self.take(name)
        tok = self.peek()
        if tok.kind == "op" and tok.text == "(":
            state = self.save()
            self.take(tok)
            close = self.peek()
            if close.kind == "op" and close.text == ")":
                self.take(close)
            else:
                self.restore(state)
        self.linebreak()
        self.function_body()

    def coproc(self, tok: ReaderToken) -> None:
        """Parse ``coproc [NAME] command``: a name only before a compound
        command, and ``time`` is a command here.

        Args:
            tok (ReaderToken): the ``coproc`` word.
        """
        self.take(tok)
        tok = self.peek(constants.READ_COMMAND)
        word = self.keyword(tok)
        if word == "time":
            word = None
        if (
            word is not None
            or tok.kind == "arith"
            or (tok.kind == "op" and tok.text == "(")
        ):
            if word is not None and word not in constants.COMPOUND_OPENERS:
                self.fail_token(tok)
            self.compound(tok)
            return
        if tok.kind == "word" and not tok.assign:
            state = self.save()
            self.take(tok)
            nxt = self.peek(constants.READ_COMMAND)
            after = self.keyword(nxt)
            if after == "time":
                after = None
            if (
                after is not None
                or nxt.kind == "arith"
                or (nxt.kind == "op" and nxt.text == "(")
            ):
                if (
                    after is not None
                    and after not in constants.COMPOUND_OPENERS
                ):
                    self.fail_token(nxt)
                self.compound(nxt)
                return
            self.restore(state)
        if tok.kind in ("word", "number") or (
            tok.kind == "op" and tok.text in constants.REDIRECTIONS
        ):
            self.simple()
            return
        self.fail_token(tok)

    def if_clause(self, tok: ReaderToken) -> None:
        self.take(tok)
        self.take(self.compound_list(words=frozenset({"then"})))
        end = self.compound_list(words=frozenset({"elif", "else", "fi"}))
        while end.text == "elif":
            self.take(end)
            self.take(self.compound_list(words=frozenset({"then"})))
            end = self.compound_list(words=frozenset({"elif", "else", "fi"}))
        if end.text == "else":
            self.take(end)
            end = self.compound_list(words=frozenset({"fi"}))
        self.take(end)

    def loop_body(self, brace: bool, separated: bool) -> None:
        """Parse a loop's ``do ... done``, or ``{ ... }``.

        Args:
            brace (bool): a brace group may stand for it.
            separated (bool): a ``;`` or newline came first, after which
                the body's place reads arrays and arithmetic.
        """
        tok = self.peek(constants.READ_FOLLOW if separated else 0)
        word = self.keyword(tok)
        if word == "do":
            self.take(tok)
            self.take(self.compound_list(words=frozenset({"done"})))
        elif word == "{" and brace:
            self.take(tok)
            self.take(self.compound_list(words=frozenset({"}"})))
        else:
            self.fail_token(tok)

    def for_clause(self, tok: ReaderToken) -> None:
        """Parse ``for``/``select NAME [in WORDS ;] body``, or an arithmetic
        ``for``; a brace body needs a separator before it, and a ``;``
        after the name cannot follow a newline.

        Args:
            tok (ReaderToken): the ``for`` or ``select`` word.
        """
        arith = tok.text == "for"
        self.take(tok)
        start = self.blank_end(self.pos)
        if arith and self.text.startswith("((", start):
            self.arith_for(start)
            return
        name = self.peek()
        if name.kind != "word":
            self.fail_token(name)
        self.take(name)
        separated = self.peek().kind == "newline"
        self.linebreak()
        tok = self.peek()
        if self.keyword(tok) == "in":
            self.take(tok)
            while (tok := self.peek()).kind == "word":
                self.take(tok)
            if tok.kind == "op" and tok.text == ";":
                self.take(tok)
            elif tok.kind != "newline":
                self.fail_token(tok)
            self.linebreak()
            separated = True
        elif not separated and tok.kind == "op" and tok.text == ";":
            self.take(tok)
            self.linebreak()
            separated = True
        self.loop_body(separated, separated)

    def arith_for(self, i: int) -> None:
        """Parse ``for ((init; test; step))`` and its body.

        Its three expressions are counted once the body is read, as bash
        does.

        Args:
            i (int): the first ``(``.
        """
        text = self.text
        end = self.matched(i + 2, i)
        if text[end + 1 : end + 2] != ")":
            if end + 1 >= self.n or text[end + 1] == "\n":
                self.fail_near(end + 1, False)
            self.fail_near(end + 3, False)
        self.pos, self.peeked = end + 2, None
        tok = self.peek()
        separated = tok.kind == "newline" or (
            tok.kind == "op" and tok.text == ";"
        )
        if tok.kind == "op" and tok.text == ";":
            self.take(tok)
        self.linebreak()
        self.loop_body(True, separated)
        parts = _semicolons(text[i + 2 : end])
        if parts != 2:
            first = (
                "arithmetic expression required"
                if parts < 2
                else "`;' unexpected"
            )
            whole = text[i : end + 2]
            self.refuse(
                [f"syntax error: {first}", f"syntax error: `{whole}'"],
                False,
                whole,
                i,
                end + 2,
            )

    def case_clause(self, tok: ReaderToken) -> None:
        """Parse ``case WORD in [(]PATTERN[|PATTERN]...) LIST ;; ... esac``.

        Inside a brace group a ``}`` where a pattern word starts closes the
        group, as bash reads it, but for the word right after ``in`` on its
        line.

        Args:
            tok (ReaderToken): the ``case`` word.
        """
        self.take(tok)
        subject = self.peek()
        if subject.kind != "word":
            self.fail_token(subject)
        self.take(subject)
        self.linebreak()
        tok = self.peek()
        if self.keyword(tok) != "in":
            self.fail_token(tok)
        self.take(tok)
        after_in = self.peek().kind != "newline"
        self.linebreak()
        while True:
            tok = self.peek()
            if self.keyword(tok) == "esac":
                self.take(tok)
                return
            if tok.kind == "op" and tok.text == "(":
                self.take(tok)
                tok = self.peek()
                after_in = False
            while True:
                if tok.kind != "word" or (
                    self.braces
                    and not after_in
                    and tok.plain
                    and tok.text == "}"
                ):
                    self.fail_token(tok)
                after_in = False
                self.take(tok)
                tok = self.peek()
                if tok.kind == "op" and tok.text == ")":
                    self.take(tok)
                    break
                if not (tok.kind == "op" and tok.text == "|"):
                    self.fail_token(tok)
                self.take(tok)
                tok = self.peek()
            end = self.compound_list(
                words=frozenset({"esac"}),
                ops=constants.CASE_TERMINATORS,
                empty=True,
            )
            self.take(end)
            if end.kind != "op":
                return
            self.linebreak()

    # -- [[ ... ]] --------------------------------------------------------------

    def conditional(self, tok: ReaderToken) -> None:
        """Parse ``[[ ... ]]``, whose errors bash words in their own family:
        its own lines, then the text it stopped at or the end of input.

        Args:
            tok (ReaderToken): the ``[[`` word.
        """
        self.take(tok)
        outer = self.depth
        self.depth = 0
        try:
            self.test_or()
            self.test_close()
        except TestFailure as failure:
            lines = list(failure.lines)
            if failure.eof:
                lines.append(self.eof_line())
                self.refuse(lines, True, "", self.n, self.n)
            tok = failure.token
            start, end = self.near_span(
                tok.end + (0 if tok.kind == "newline" else 1)
            )
            word = self.text[start:end]
            lines.append(f"syntax error near `{word}'")
            self.refuse(lines, False, word, start, end)
        finally:
            self.depth = outer

    def test_peek(self) -> ReaderToken:
        self.linebreak()
        return self.peek(constants.READ_TEST)

    def test_word(self) -> ReaderToken:
        return self.peek(constants.READ_TEST)

    def test_after(self) -> ReaderToken:
        """The token after a whole test; ending inside a quote there, bash
        adds that it was looking for ``]]``."""
        try:
            return self.test_peek()
        except ReaderRefusal as refusal:
            if refusal.eof and not self.depth:
                refusal.lines.append("unexpected EOF while looking for `]]'")
            raise

    def test_close(self) -> None:
        tok = self.test_after()
        if _is_test_close(tok):
            self.take(tok)
            return
        if tok.kind == "eof":
            raise TestFailure(
                ["unexpected EOF while looking for `]]'"], tok, True
            )
        if tok.kind == "word":
            raise TestFailure(["syntax error in conditional expression"], tok)
        raise TestFailure(
            [
                "syntax error in conditional expression: unexpected token "
                f"`{_test_text(tok)}'"
            ],
            tok,
        )

    def test_or(self) -> None:
        self.test_and()
        while (tok := self.test_after()).kind == "op" and tok.text == "||":
            self.take(tok)
            self.test_and()

    def test_and(self) -> None:
        self.test_term()
        while (tok := self.test_after()).kind == "op" and tok.text == "&&":
            self.take(tok)
            self.test_term()

    def test_term(self) -> None:
        """Parse one test: ``! TEST``, ``( EXPR )``, ``OP WORD``, ``WORD
        OP WORD`` or ``WORD``."""
        tok = self.test_peek()
        if tok.kind == "eof":
            raise TestFailure(
                ["unexpected token `EOF' in conditional command"], tok, True
            )
        if _is_test_close(tok):
            raise TestFailure([], tok)
        if tok.kind == "word" and tok.plain and tok.text == "!":
            self.take(tok)
            self.test_term()
            return
        if tok.kind == "op" and tok.text == "(":
            self.test_group(tok)
            return
        if tok.kind != "word":
            raise TestFailure(
                [
                    f"unexpected token `{_test_text(tok)}' in conditional command"
                ],
                tok,
            )
        if tok.plain and tok.text in constants.UNARY_TESTS:
            self.take(tok)
            arg = self.test_operand("unary", self.test_word)
            if arg.kind != "word" or _is_test_close(arg):
                raise TestFailure(
                    [
                        f"unexpected argument `{_test_text(arg)}' to "
                        "conditional unary operator"
                    ],
                    arg,
                )
            self.take(arg)
            return
        self.take(tok)
        try:
            op = self.peek(constants.READ_TEST)
        except ReaderRefusal as refusal:
            if refusal.eof:
                refusal.lines.append("conditional binary operator expected")
            raise
        if (
            op.kind == "word"
            and op.plain
            and op.text in constants.BINARY_TESTS
        ) or (op.kind == "op" and op.text in ("<", ">")):
            self.take(op)
            reader = self.test_word
            if op.text == "=~":
                reader = self.regex_word
            elif op.text in ("==", "=", "!="):
                reader = self.pattern_word
            arg = self.test_operand("binary", reader)
            if arg.kind != "word" or _is_test_close(arg):
                raise TestFailure(
                    [
                        f"unexpected argument `{_test_text(arg)}' to "
                        "conditional binary operator"
                    ],
                    arg,
                )
            self.take(arg)
            return
        if (
            op.kind == "op" and op.text in ("&&", "||", ")")
        ) or _is_test_close(op):
            return
        if op.kind == "word":
            raise TestFailure(["conditional binary operator expected"], op)
        raise TestFailure(
            [
                f"unexpected token `{_test_text(op)}', conditional binary "
                "operator expected"
            ],
            op,
            op.kind == "eof",
        )

    def test_group(self, tok: ReaderToken) -> None:
        """Parse ``( EXPR )``; every error inside adds that bash expected
        the ``)``.

        Args:
            tok (ReaderToken): the ``(``.
        """
        if self.nesting >= constants.MAX_NESTING:
            self.fail_token(tok)
        self.take(tok)
        self.depth += 1
        self.nesting += 1
        try:
            self.test_or()
            close = self.test_peek()
        except TestFailure as failure:
            failure.lines.append("expected `)'")
            raise
        except ReaderRefusal as refusal:
            if refusal.eof:
                refusal.lines.append("expected `)'")
            raise
        finally:
            self.depth -= 1
            self.nesting -= 1
        if close.kind == "op" and close.text == ")":
            self.take(close)
            return
        if close.kind == "word" and not _is_test_close(close):
            raise TestFailure(["expected `)'"], close)
        raise TestFailure(
            [f"unexpected token `{_test_text(close)}', expected `)'"],
            close,
            close.kind == "eof",
        )

    def test_operand(
        self, kind: str, reader: Callable[[], ReaderToken]
    ) -> ReaderToken:
        """Read an operator's operand; ending inside a quote there, bash
        adds that the operator's argument is missing.

        Args:
            kind (str): ``unary`` or ``binary``.
            reader (Callable[[], ReaderToken]): reads the operand.
        """
        try:
            return reader()
        except ReaderRefusal as refusal:
            if refusal.eof:
                refusal.lines.append(
                    f"unexpected argument to conditional {kind} operator"
                )
            raise

    def pattern_word(self) -> ReaderToken:
        """The right side of ``==``, ``=`` or ``!=``, read with extglob on."""
        i = self.blank_end(self.pos)
        text, n = self.text, self.n
        tok = self.lex(i, constants.READ_TEST)
        if tok.kind != "word" and not (
            text[i : i + 1] in constants.EXTGLOB_OPENERS
            and text[i + 1 : i + 2] == "("
        ):
            return tok
        j = i
        extended = False
        while j < n:
            c = text[j]
            if c in constants.EXTGLOB_OPENERS and text[j + 1 : j + 2] == "(":
                j = self.extended_pattern(j)
                extended = True
                continue
            if c in constants.WORD_BREAKS:
                break
            j = self.word_char(j)
        if not extended:
            return tok
        return ReaderToken("word", text[i:j].replace("\\\n", ""), i, j)

    def regex_word(self) -> ReaderToken:
        """The right side of ``=~``: parentheses group blanks into it and
        ``|`` is part of it; ``;``, ``<``, ``>``, ``)`` and ``&`` end it,
        and one of them first is an empty pattern. A ``#`` first starts a
        comment, as at any word's start."""
        i = self.blank_end(self.pos)
        text, n = self.text, self.n
        if i >= n or text[i] in "\n#":
            return self.lex(i, 0)
        if text[i] in ";<>)&":
            return ReaderToken("word", "", i, i)
        j = i
        while j < n:
            c = text[j]
            if c == "(":
                j = self.matched(j + 1, j) + 1
                continue
            if c in " \t\n;<>)&":
                break
            j = self.word_char(j)
        word = text[i:j].replace("\\\n", "")
        return ReaderToken("word", word, i, j, word == "]]")
