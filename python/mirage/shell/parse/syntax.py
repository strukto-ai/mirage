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
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import NamedTuple, NoReturn

from mirage.io import IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.constants import (
    ARRAY_BUILTINS,
    BASH_KEYWORDS,
    BINARY_TESTS,
    CASE_TERMINATORS,
    CLOSING_WORDS,
    COMPOUND_OPENERS,
    EXTGLOB_OPENERS,
    MAX_NESTING,
    NAME_CHARS,
    NAME_START,
    NEAR_TEXT_STOPS,
    OPERATOR_CHARS,
    OPERATORS,
    READ_ARITH,
    READ_ARRAYS,
    READ_BODY,
    READ_COMMAND,
    READ_ELEMENT,
    READ_FOLLOW,
    READ_KEYS,
    READ_PREFIX,
    READ_START,
    READ_SUBSCRIPTS,
    READ_TEST,
    REDIRECTIONS,
    RESERVED_WORDS,
    SEPARATOR_TOKENS,
    STRUCTURAL_TOKENS,
    UNARY_TESTS,
    WORD_BREAKS,
)
from mirage.shell.parse.heredoc.delimiter import (
    clean_delimiter,
    delimiter_quoted,
)
from mirage.shell.parse.types import SourceSpan, SyntaxDiagnostic
from mirage.shell.types import TSNodeLike

logger = logging.getLogger(__name__)


class _Token(NamedTuple):
    kind: str
    text: str
    start: int
    end: int
    plain: bool = False
    assign: bool = False


class _Heredoc(NamedTuple):
    at: int
    delimiter: str
    strip: bool
    quoted: bool


class _Refusal(Exception):
    """An error bash reports while reading a line, in its own words.

    Args:
        lines (list[str]): the diagnostic lines, without a prefix.
        status (int): the status bash refuses the line with.
        offending (str): the text bash names, empty at the end of input.
        start (int): where that text starts in the line.
        end (int): where it ends.
        eof (bool): the input ended inside a construct.
    """

    def __init__(
        self,
        lines: list[str],
        status: int,
        offending: str,
        start: int,
        end: int,
        eof: bool,
    ) -> None:
        super().__init__(lines)
        self.lines = lines
        self.status = status
        self.offending = offending
        self.start = start
        self.end = end
        self.eof = eof


class _TestFailure(Exception):
    """A ``[[ ]]`` expression bash refuses, before the line naming where.

    Args:
        lines (list[str]): the conditional's own diagnostic lines.
        token (_Token): the token it stopped at.
        eof (bool): the input ended inside the expression.
    """

    def __init__(
        self, lines: list[str], token: _Token, eof: bool = False
    ) -> None:
        super().__init__(lines)
        self.lines = lines
        self.token = token
        self.eof = eof


def check_syntax(
    command: str,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
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
        own (Mapping[str, tuple[int, int]] | None): each alias whose own
            text the line opens with, to the characters of the line that
            text covers, inside which its name stays reserved.

    Returns:
        SyntaxDiagnostic | None: what bash prints and its status, the span
        in UTF-8 bytes; None when bash reads the line.
    """
    try:
        found = _LineReader(command, aliases, own or {}).refusals()
    except RecursionError:
        logger.debug("line nested past the host's stack, refused")
        found = [
            _Refusal(["syntax error: nesting too deep"], 2, "", 0, 0, False)
        ]
    if not found:
        return None
    first = found[0]
    message = "".join(
        f"{_mirage_wording(line)}\n"
        for refusal in found
        for line in refusal.lines
    )
    start = len(encode_text(command[: first.start]))
    span = SourceSpan(
        start, start + len(encode_text(command[first.start : first.end]))
    )
    return SyntaxDiagnostic(first.offending, span, message, found[-1].status)


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
    blanks, and the grammar recovers a quoted heredoc's last line and a
    ``for`` header's ``in`` as errors of its own, and the ``;`` it misses
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
    previous = None
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
            if _is_recovered_quoted_heredoc_end(previous, child):
                previous = child
                continue
            return _issue(child)
        if child.type != "ERROR":
            nested = find_syntax_issue(child)
            if nested is not None:
                return nested
        if child.is_named:
            previous = child
    return None


def _issue(node: TSNodeLike) -> SyntaxDiagnostic:
    text = decode_text(node.text or b"")
    snippet = text.strip()
    message = (
        f"mirage: syntax error near '{snippet}'\n"
        if snippet
        else "mirage: syntax error in command\n"
    )
    return SyntaxDiagnostic(
        text, SourceSpan(node.start_byte, node.end_byte), message
    )


def _is_structural_error(node: TSNodeLike) -> bool:
    """Whether an ERROR node holds a token that structures a line.

    Args:
        node (TSNodeLike): the ERROR node.
    """
    return any(
        child.is_named
        or child.type in BASH_KEYWORDS
        or child.type in STRUCTURAL_TOKENS
        or child.type in SEPARATOR_TOKENS
        for child in node.children
    )


def _walk_named(node: TSNodeLike) -> Iterator[TSNodeLike]:
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.named_children))


def _is_recovered_quoted_heredoc_end(
    previous: TSNodeLike | None, error: TSNodeLike
) -> bool:
    """Whether an ERROR is a quoted heredoc's last line the grammar missed.

    Args:
        previous (TSNodeLike | None): the named sibling before it.
        error (TSNodeLike): the ERROR node.
    """
    if previous is None:
        return False
    error_text = decode_text(error.text or b"").strip()
    if not error_text:
        return False
    for candidate in _walk_named(previous):
        if candidate.type != "heredoc_redirect":
            continue
        start = None
        end = None
        for child in candidate.named_children:
            if child.type == "heredoc_start":
                start = decode_text(child.text or b"")
            elif child.type == "heredoc_end":
                end = decode_text(child.text or b"")
        if (
            start is not None
            and ("'" in start or '"' in start)
            and not end
            and start.replace("'", "").replace('"', "") == error_text
        ):
            return True
    return False


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
        and text[0] in NAME_START
        and all(c in NAME_CHARS for c in text)
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


def _test_text(tok: _Token) -> str:
    if tok.kind == "newline":
        return "newline"
    if tok.kind == "eof":
        return "EOF"
    return tok.text


def _is_test_close(tok: _Token) -> bool:
    return tok.kind == "word" and tok.plain and tok.text == "]]"


_ReaderState = tuple[
    int, tuple[int, int, _Token] | None, tuple[_Heredoc, ...], bool
]


class _LineReader:
    """bash's reader over one line: a lexer whose modes the grammar sets.

    The line is read as bash reads its input: a newline ends the input if
    none does, a trailing backslash quotes the end of it, and each heredoc
    body is skipped after the newline that ends its command. ``frames``
    tracks the arrays and substitutions being read, which decide the
    status of an error inside them.

    Args:
        text (str): the line.
        aliases (frozenset[str]): as in ``check_syntax``.
        own (Mapping[str, tuple[int, int]]): as in ``check_syntax``.
    """

    def __init__(
        self,
        text: str,
        aliases: frozenset[str],
        own: Mapping[str, tuple[int, int]],
    ) -> None:
        self.text = text
        self.n = len(text)
        self.quoted_end = (len(text) - len(text.rstrip("\\"))) % 2 == 1
        self.aliases = aliases
        self.own = own
        self.subs: dict[
            tuple[int, int | None], tuple[int, tuple[_Heredoc, ...]]
        ] = {}
        self.reset(0)

    def reset(self, pos: int) -> None:
        self.pos = pos
        self.ended = self.quoted_end or self.text.endswith("\n")
        self.limit: int | None = None
        self.floor = 0
        self.frames: list[str] = []
        self.heredocs: tuple[_Heredoc, ...] = ()
        self.peeked: tuple[int, int, _Token] | None = None
        self.after = False
        self.matching = False
        self.depth = 0
        self.nesting = 0
        self.braces = 0

    def refusals(self) -> list[_Refusal]:
        """Every error bash reports for the line, in order.

        An array bash cannot read discards the rest of its line only, so
        the next line is read on; an end of input inside a quote then
        leaves the status as it was.
        """
        found: list[_Refusal] = []
        while True:
            try:
                self.program()
                return found
            except _Refusal as refusal:
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
        raise _Refusal(lines, self.status(eof), offending, start, end, eof)

    def fail_token(self, tok: _Token) -> NoReturn:
        """Refuse the line at a token bash cannot take where it stands.

        Args:
            tok (_Token): the token.
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
            if c in NEAR_TEXT_STOPS:
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
        at = self.joined(i + 1)
        nxt = text[at : at + 1]
        if nxt == "$":
            return at + 1
        if nxt == "(":
            inner = self.joined(at + 1)
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
        at = self.joined(i + 1)
        if self.char_at(at + 1) == "(":
            return self.matched(at + 1, i) + 1
        return self.substitution(i, at + 1)

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

    def save(self) -> _ReaderState:
        return (self.pos, self.peeked, self.heredocs, self.after)

    def restore(self, state: _ReaderState) -> None:
        self.pos, self.peeked, self.heredocs, self.after = state

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
            self.pend(known[1])
            return known[0]
        if self.nesting >= MAX_NESTING:
            opener = self.text[opened:j].replace("\\\n", "")
            self.fail_token(_Token("op", opener, opened, j))
        state = self.save()
        self.pos, self.peeked, self.heredocs = j, None, ()
        self.frames.append("sub")
        self.nesting += 1
        self.linebreak()
        while True:
            tok = self.peek(READ_COMMAND)
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
        pending = self.heredocs
        self.restore(state)
        self.pend(pending)
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
        element = READ_ELEMENT | (READ_SUBSCRIPTS if mode & READ_KEYS else 0)
        while True:
            tok = self.peek(element)
            if (
                mode & READ_BODY
                and tok.kind == "word"
                and tok.plain
                and tok.text in RESERVED_WORDS
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
        self.pend(opened)
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
            if text[j] not in OPERATOR_CHARS:
                break
            chars.append(text[j])
            j += 1
            ends.append(j)
        spelled = "".join(chars)
        for op in OPERATORS:
            if spelled.startswith(op):
                return op, ends[len(op) - 1]
        return None

    def peek(self, mode: int = 0) -> _Token:
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

    def peek_after(self) -> _Token:
        """The token after a command. After a compound one it is read as
        where a command starts: reserved words, arrays and arithmetic."""
        return self.peek(READ_FOLLOW if self.after else 0)

    def take(self, tok: _Token) -> None:
        self.peeked = None
        self.pos = tok.end
        if tok.kind == "newline":
            if tok.start == tok.end:
                self.ended = True
            elif self.heredocs:
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
        for _, delimiter, strip, quoted in self.heredocs:
            while i < n:
                end = text.find("\n", i, n)
                end = n if end < 0 else end
                line = text[i:end]
                while (
                    not quoted
                    and end < n
                    and (len(line) - len(line.rstrip("\\"))) % 2
                ):
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
                    self.heredocs = ()
                    return i + len(line) - len(body) + len(delimiter)
                i = min(end + 1, n)
        self.heredocs = ()
        return i

    def pend(self, heredocs: Iterable[_Heredoc]) -> None:
        """Add heredocs whose bodies the next newline reads, each once: a
        word read again in another mode opens the same ones again.

        Args:
            heredocs (Iterable[_Heredoc]): the heredocs, by where they open.
        """
        known = {heredoc.at for heredoc in self.heredocs}
        self.heredocs += tuple(h for h in heredocs if h.at not in known)

    def joined(self, i: int) -> int:
        """Where the next character is once continued lines are joined, as
        bash joins them before it reads one.

        Args:
            i (int): where to look.
        """
        while self.text.startswith("\\\n", i):
            i += 2
        return i

    def char_at(self, i: int) -> str:
        """The character at ``i`` once continued lines are joined, or ``''``
        at the end of the line.

        Args:
            i (int): where to look.
        """
        i = self.joined(i)
        return self.text[i : i + 1]

    def lex(self, i: int, mode: int) -> _Token:
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
            return _Token("eof", "", i, i)
        if i >= n:
            if self.ended:
                return _Token("eof", "", n, n)
            return _Token("newline", "\n", n, n)
        c = text[i]
        if c == "\n":
            return _Token("newline", "\n", i, i + 1)
        if mode & READ_ARITH and text.startswith("((", i):
            return self.arith_command(i, bool(mode & READ_START))
        if c in "<>" and self.char_at(i + 1) == "(":
            return self.word(i, 0)
        op = self.operator(i)
        if op is not None:
            return _Token("op", op[0], i, op[1])
        if c == "{" and not mode & READ_TEST:
            close = text.find("}", i, n)
            if (
                close > i
                and _is_name(text[i + 1 : close])
                and text[close + 1 : close + 2] in ("<", ">")
                and text[close + 2 : close + 3] != "("
            ):
                return _Token("redirvar", text[i : close + 1], i, close + 1)
        if c.isdigit() and not mode & READ_TEST:
            j = i
            while j < n and text[j].isdigit():
                j += 1
            if j < n and text[j] in "<>" and text[j + 1 : j + 2] != "(":
                return _Token("number", text[i:j], i, j)
        return self.word(i, mode)

    def word(self, i: int, mode: int) -> _Token:
        """Read a word, and the assignment or array it may open.

        Args:
            i (int): where it starts.
            mode (int): the ``READ_*`` flags.
        """
        text, n = self.text, self.n
        start = i
        plain = True
        state = "start" if mode & READ_PREFIX else "none"
        assign = False
        if mode & READ_ELEMENT and text[i] == "[":
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
            if c in WORD_BREAKS:
                if c in "<>" and self.char_at(i + 1) == "(":
                    i = self.process_substitution(i)
                    plain = False
                    state = "none"
                    continue
                break
            if state in ("start", "name"):
                if c in NAME_START or (state == "name" and c in NAME_CHARS):
                    state = "name"
                elif state == "name" and c == "[":
                    end = (
                        self.bracket(i + 1, i)
                        if mode & READ_SUBSCRIPTS
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
                i = (i if c == "=" else self.joined(i + 1)) + 1
                opener = self.joined(i)
                if mode & READ_ARRAYS and text[opener : opener + 1] == "(":
                    i = self.array(opener, mode)
                    plain = False
                continue
            if c in "'\"`$":
                plain = False
                state = "none"
            i = self.word_char(i)
        return _Token(
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
        while j < n and text[j] not in WORD_BREAKS:
            if text[j] == "]":
                return j + 1
            j += 1
        return None

    def arith_command(self, i: int, start: bool) -> _Token:
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
            return _Token("arith", text[i : end + 2], i, end + 2)
        if start and (end + 1 >= self.n or text[end + 1] == "\n"):
            if self.nesting >= MAX_NESTING:
                self.fail_token(_Token("op", "(", i, i + 1))
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
        return _Token("op", "(", i, i + 1)

    # -- grammar ------------------------------------------------------------

    def keyword(self, tok: _Token) -> str | None:
        """The reserved word a token is where a command starts, if any.

        A closing word an alias spells is a command, except inside that
        alias's own text and inside a substitution.

        Args:
            tok (_Token): the token.
        """
        if (
            tok.kind != "word"
            or not tok.plain
            or tok.text not in RESERVED_WORDS
        ):
            return None
        if (
            tok.text in CLOSING_WORDS
            and tok.text in self.aliases
            and "sub" not in self.frames
        ):
            span = self.own.get(tok.text)
            if span is None or not span[0] <= tok.start < span[1]:
                return None
        return tok.text

    def linebreak(self) -> None:
        while (tok := self.peek()).kind == "newline":
            self.take(tok)

    def program(self) -> None:
        self.linebreak()
        while True:
            tok = self.peek(READ_COMMAND)
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
        self, tok: _Token, words: frozenset[str], ops: frozenset[str]
    ) -> bool:
        if tok.kind == "op":
            return tok.text in ops
        return self.keyword(tok) in words

    def compound_list(
        self,
        words: frozenset[str] = frozenset(),
        ops: frozenset[str] = frozenset(),
        empty: bool = False,
    ) -> _Token:
        """Parse commands up to a closing word or operator; return it.

        Args:
            words (frozenset[str]): the reserved words that end the list.
            ops (frozenset[str]): the operators that end it.
            empty (bool): the list may hold no command (a case item).
        """
        self.linebreak()
        seen = False
        while True:
            tok = self.peek(READ_COMMAND)
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
            tok = self.peek(READ_COMMAND)
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
            tok = self.peek(READ_COMMAND)
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
        tok = self.peek(READ_COMMAND)
        word = self.keyword(tok)
        if piped and word == "time":
            word = None
        if word is not None:
            if word not in COMPOUND_OPENERS and word not in (
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
            tok.kind == "op" and tok.text in REDIRECTIONS
        ):
            self.simple()
            return
        self.fail_token(tok)

    def compound(self, tok: _Token) -> None:
        """Parse a compound command, a function definition or a coproc;
        one nested ``MAX_NESTING`` deep is refused at its opener.

        Args:
            tok (_Token): the token it opens with.
        """
        if self.nesting >= MAX_NESTING:
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
                tok.kind == "op" and tok.text in REDIRECTIONS
            ):
                self.redirect(tok)
                self.after = False
            else:
                return

    def redirect(self, tok: _Token) -> None:
        """Parse a redirection: its operator and target word.

        Args:
            tok (_Token): its descriptor or operator.
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
                    _Heredoc(
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
        mode = READ_PREFIX
        assigned = False
        prefixed = False
        while True:
            tok = self.peek(mode)
            if tok.kind in ("number", "redirvar") or (
                tok.kind == "op" and tok.text in REDIRECTIONS
            ):
                self.redirect(tok)
                mode = 0 if assigned else READ_PREFIX | READ_KEYS
                prefixed = True
            elif tok.kind == "word" and tok.assign:
                self.take(tok)
                mode &= ~READ_KEYS
                assigned = prefixed = True
            else:
                break
        if tok.kind == "word":
            self.take(tok)
            if not prefixed:
                nxt = self.peek()
                if nxt.kind == "op" and nxt.text == "(":
                    self.take(nxt)
                    close = self.peek(READ_FOLLOW)
                    if not (close.kind == "op" and close.text == ")"):
                        self.fail_token(close)
                    self.take(close)
                    self.linebreak()
                    self.function_body()
                    return
            mode = (
                READ_ARRAYS if tok.plain and tok.text in ARRAY_BUILTINS else 0
            )
            while True:
                tok = self.peek(mode)
                if tok.kind == "word":
                    self.take(tok)
                elif tok.kind in ("number", "redirvar") or (
                    tok.kind == "op" and tok.text in REDIRECTIONS
                ):
                    self.redirect(tok)
                    mode = 0
                else:
                    break
        if tok.kind == "op" and tok.text == "(":
            self.fail_token(tok)

    def function_body(self) -> None:
        tok = self.peek(READ_COMMAND | READ_BODY)
        word = self.keyword(tok)
        if (
            (word is not None and word in COMPOUND_OPENERS)
            or tok.kind == "arith"
            or (tok.kind == "op" and tok.text == "(")
        ):
            self.compound(tok)
            self.redirects()
            return
        self.fail_token(tok)

    def function(self, tok: _Token) -> None:
        """Parse ``function NAME [()] body``; a ``(`` not followed by
        ``)`` opens a subshell body.

        Args:
            tok (_Token): the ``function`` word.
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

    def coproc(self, tok: _Token) -> None:
        """Parse ``coproc [NAME] command``: a name only before a compound
        command, and ``time`` is a command here.

        Args:
            tok (_Token): the ``coproc`` word.
        """
        self.take(tok)
        tok = self.peek(READ_COMMAND)
        word = self.keyword(tok)
        if word == "time":
            word = None
        if (
            word is not None
            or tok.kind == "arith"
            or (tok.kind == "op" and tok.text == "(")
        ):
            if word is not None and word not in COMPOUND_OPENERS:
                self.fail_token(tok)
            self.compound(tok)
            return
        if tok.kind == "word" and not tok.assign:
            state = self.save()
            self.take(tok)
            nxt = self.peek(READ_COMMAND)
            after = self.keyword(nxt)
            if after == "time":
                after = None
            if (
                after is not None
                or nxt.kind == "arith"
                or (nxt.kind == "op" and nxt.text == "(")
            ):
                if after is not None and after not in COMPOUND_OPENERS:
                    self.fail_token(nxt)
                self.compound(nxt)
                return
            self.restore(state)
        if tok.kind in ("word", "number") or (
            tok.kind == "op" and tok.text in REDIRECTIONS
        ):
            self.simple()
            return
        self.fail_token(tok)

    def if_clause(self, tok: _Token) -> None:
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
        tok = self.peek(READ_FOLLOW if separated else 0)
        word = self.keyword(tok)
        if word == "do":
            self.take(tok)
            self.take(self.compound_list(words=frozenset({"done"})))
        elif word == "{" and brace:
            self.take(tok)
            self.take(self.compound_list(words=frozenset({"}"})))
        else:
            self.fail_token(tok)

    def for_clause(self, tok: _Token) -> None:
        """Parse ``for``/``select NAME [in WORDS ;] body``, or an arithmetic
        ``for``; a brace body needs a separator before it, and a ``;``
        after the name cannot follow a newline.

        Args:
            tok (_Token): the ``for`` or ``select`` word.
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

    def case_clause(self, tok: _Token) -> None:
        """Parse ``case WORD in [(]PATTERN[|PATTERN]...) LIST ;; ... esac``.

        Inside a brace group a ``}`` where a pattern word starts closes the
        group, as bash reads it, but for the word right after ``in`` on its
        line.

        Args:
            tok (_Token): the ``case`` word.
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
                words=frozenset({"esac"}), ops=CASE_TERMINATORS, empty=True
            )
            self.take(end)
            if end.kind != "op":
                return
            self.linebreak()

    # -- [[ ... ]] --------------------------------------------------------------

    def conditional(self, tok: _Token) -> None:
        """Parse ``[[ ... ]]``, whose errors bash words in their own family:
        its own lines, then the text it stopped at or the end of input.

        Args:
            tok (_Token): the ``[[`` word.
        """
        self.take(tok)
        outer = self.depth
        self.depth = 0
        try:
            self.test_or()
            self.test_close()
        except _TestFailure as failure:
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

    def test_peek(self) -> _Token:
        self.linebreak()
        return self.peek(READ_TEST)

    def test_word(self) -> _Token:
        return self.peek(READ_TEST)

    def test_after(self) -> _Token:
        """The token after a whole test; ending inside a quote there, bash
        adds that it was looking for ``]]``."""
        try:
            return self.test_peek()
        except _Refusal as refusal:
            if refusal.eof and not self.depth:
                refusal.lines.append("unexpected EOF while looking for `]]'")
            raise

    def test_close(self) -> None:
        tok = self.test_after()
        if _is_test_close(tok):
            self.take(tok)
            return
        if tok.kind == "eof":
            raise _TestFailure(
                ["unexpected EOF while looking for `]]'"], tok, True
            )
        if tok.kind == "word":
            raise _TestFailure(["syntax error in conditional expression"], tok)
        raise _TestFailure(
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
            raise _TestFailure(
                ["unexpected token `EOF' in conditional command"], tok, True
            )
        if _is_test_close(tok):
            raise _TestFailure([], tok)
        if tok.kind == "word" and tok.plain and tok.text == "!":
            self.take(tok)
            self.test_term()
            return
        if tok.kind == "op" and tok.text == "(":
            self.test_group(tok)
            return
        if tok.kind != "word":
            raise _TestFailure(
                [
                    f"unexpected token `{_test_text(tok)}' in conditional command"
                ],
                tok,
            )
        if tok.plain and tok.text in UNARY_TESTS:
            self.take(tok)
            arg = self.test_operand("unary", self.test_word)
            if arg.kind != "word" or _is_test_close(arg):
                raise _TestFailure(
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
            op = self.peek(READ_TEST)
        except _Refusal as refusal:
            if refusal.eof:
                refusal.lines.append("conditional binary operator expected")
            raise
        if (op.kind == "word" and op.plain and op.text in BINARY_TESTS) or (
            op.kind == "op" and op.text in ("<", ">")
        ):
            self.take(op)
            reader = self.test_word
            if op.text == "=~":
                reader = self.regex_word
            elif op.text in ("==", "=", "!="):
                reader = self.pattern_word
            arg = self.test_operand("binary", reader)
            if arg.kind != "word" or _is_test_close(arg):
                raise _TestFailure(
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
            raise _TestFailure(["conditional binary operator expected"], op)
        raise _TestFailure(
            [
                f"unexpected token `{_test_text(op)}', conditional binary "
                "operator expected"
            ],
            op,
            op.kind == "eof",
        )

    def test_group(self, tok: _Token) -> None:
        """Parse ``( EXPR )``; every error inside adds that bash expected
        the ``)``.

        Args:
            tok (_Token): the ``(``.
        """
        if self.nesting >= MAX_NESTING:
            self.fail_token(tok)
        self.take(tok)
        self.depth += 1
        self.nesting += 1
        try:
            self.test_or()
            close = self.test_peek()
        except _TestFailure as failure:
            failure.lines.append("expected `)'")
            raise
        except _Refusal as refusal:
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
            raise _TestFailure(["expected `)'"], close)
        raise _TestFailure(
            [f"unexpected token `{_test_text(close)}', expected `)'"],
            close,
            close.kind == "eof",
        )

    def test_operand(self, kind: str, reader: Callable[[], _Token]) -> _Token:
        """Read an operator's operand; ending inside a quote there, bash
        adds that the operator's argument is missing.

        Args:
            kind (str): ``unary`` or ``binary``.
            reader (Callable[[], _Token]): reads the operand.
        """
        try:
            return reader()
        except _Refusal as refusal:
            if refusal.eof:
                refusal.lines.append(
                    f"unexpected argument to conditional {kind} operator"
                )
            raise

    def pattern_word(self) -> _Token:
        """The right side of ``==``, ``=`` or ``!=``, read with extglob on."""
        i = self.blank_end(self.pos)
        text, n = self.text, self.n
        tok = self.lex(i, READ_TEST)
        if tok.kind != "word" and not (
            text[i : i + 1] in EXTGLOB_OPENERS and text[i + 1 : i + 2] == "("
        ):
            return tok
        j = i
        extended = False
        while j < n:
            c = text[j]
            if c in EXTGLOB_OPENERS and text[j + 1 : j + 2] == "(":
                j = self.matched(j + 2, j + 1) + 1
                extended = True
                continue
            if c in WORD_BREAKS:
                break
            j = self.word_char(j)
        if not extended:
            return tok
        return _Token("word", text[i:j].replace("\\\n", ""), i, j)

    def regex_word(self) -> _Token:
        """The right side of ``=~``: parentheses group blanks into it and
        ``|`` is part of it; ``;``, ``<``, ``>``, ``)`` and ``&`` end it,
        and one of them first is an empty pattern. A ``#`` first starts a
        comment, as at any word's start."""
        i = self.blank_end(self.pos)
        text, n = self.text, self.n
        if i >= n or text[i] in "\n#":
            return self.lex(i, 0)
        if text[i] in ";<>)&":
            return _Token("word", "", i, i)
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
        return _Token("word", word, i, j, word == "]]")
