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

import tree_sitter
import tree_sitter_bash

BASH_LANGUAGE = tree_sitter.Language(tree_sitter_bash.language())
TS_PARSER = tree_sitter.Parser(BASH_LANGUAGE)

ARITH_OPEN_TOKEN = "(("
_QUOTES = (b"'", b'"')


def _balanced_end(data: bytes, start: int) -> int | None:
    """Index just past the ``)`` closing the ``(`` at ``start``.

    Parens inside quotes and backslash escapes do not count, so a
    command substitution or a literal ``")"`` cannot throw off the
    depth. Scanned as bytes because tree-sitter reports byte offsets;
    the delimiters are all ASCII, so multibyte characters pass through
    without matching anything.

    Args:
        data (bytes): encoded shell source.
        start (int): byte offset of the opening paren.

    Returns:
        int | None: end offset, or None when the parens never balance.
    """
    depth = 0
    index = start
    quote: bytes | None = None
    while index < len(data):
        char = data[index:index + 1]
        if quote is not None:
            if char == b"\\" and quote == b'"':
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in _QUOTES:
            quote = char
        elif char == b"\\":
            index += 2
            continue
        elif char == b"(":
            depth += 1
        elif char == b")":
            depth -= 1
            if depth == 0:
                return index + 1
        index += 1
    return None


def _is_arithmetic(data: bytes, start: int) -> bool:
    """Whether the construct at ``start`` is a real arithmetic command.

    Decided by parsing the balanced span on its own: ``((i++))`` stands
    alone cleanly, while ``((echo x); echo $i)`` does not. Judging each
    opener separately is what keeps a valid ``((i++))`` safe when it
    shares a line with a broken one, since tree-sitter's error region
    covers both.

    Args:
        data (bytes): encoded shell source.
        start (int): byte offset of the opener's first paren.
    """
    end = _balanced_end(data, start)
    if end is None:
        # Unbalanced: no span to judge, so assume arithmetic and leave
        # the construct alone rather than risk rewriting it.
        return True
    return not TS_PARSER.parse(data[start:end]).root_node.has_error


def _failed_arith_openers(root: tree_sitter.Node) -> list[int]:
    """Byte offsets of ``((`` tokens the parser could not make sense of.

    Only openers inside an ERROR subtree are reported. A genuine
    ``((i++))`` parses as an arithmetic command and never lands in one,
    so it cannot be picked up here.

    Args:
        root (tree_sitter.Node): root of a tree that has an error.
    """
    offsets: list[int] = []
    stack: list[tuple[tree_sitter.Node, bool]] = [(root, False)]
    while stack:
        node, in_error = stack.pop()
        errored = in_error or node.type == "ERROR"
        if errored and node.type == ARITH_OPEN_TOKEN:
            offsets.append(node.start_byte)
        for child in node.children:
            stack.append((child, errored))
    return offsets


def strip_line_continuation(command: str) -> str:
    """Drop a trailing backslash that continues the line, as bash does.

    The reader removes ``\\<newline>`` before the parser ever sees it, and
    a backslash ending the input is the same thing with nothing left to
    continue onto: ``echo a\\`` runs ``echo a``. Only an odd-length run
    of trailing backslashes ends in a live one, since each earlier pair
    is an escaped backslash (``echo a\\\\`` keeps its literal backslash).

    Args:
        command (str): the raw command line.
    """
    stripped = command.rstrip("\\")
    if (len(command) - len(stripped)) % 2 == 1:
        return command[:-1]
    return command


def find_unterminated_backtick(command: str) -> str | None:
    """Locate a backtick substitution that is never closed.

    tree-sitter happily parses ``echo `echo a`` as a complete command,
    so the region has to be scanned directly. Quoting follows the shell
    reader: single quotes protect a backtick, double quotes do not, and
    once inside a substitution only a backslash escapes, which is why
    ``"`echo '`'`"`` is an error in bash rather than a quoted backtick.

    Args:
        command (str): the raw command line.

    Returns:
        str | None: text from the unmatched backtick on, or None.
    """
    quote: str | None = None
    dollar_quote = False
    opened: int | None = None
    last_dollar = -2
    i = 0
    while i < len(command):
        ch = command[i]
        if quote == "'":
            # $'...' takes backslash escapes, so \' does not close it;
            # a plain '...' treats every backslash literally.
            if dollar_quote and ch == "\\":
                i += 2
                continue
            if ch == "'":
                quote = None
                dollar_quote = False
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if opened is not None:
            if ch == "`":
                opened = None
            i += 1
            continue
        if ch == "`":
            opened = i
        elif ch == "'" and quote is None:
            quote = "'"
            dollar_quote = last_dollar == i - 1
        elif ch == '"':
            quote = None if quote == '"' else '"'
        elif ch == "$":
            last_dollar = i
        i += 1
    return command[opened:] if opened is not None else None


def parse(command: str) -> tree_sitter.Node:
    """Parse a shell command string into a tree-sitter AST.

    A leading ``((`` is lexed as the arithmetic opener and the lexer
    cannot back out, so a subshell that immediately opens another
    subshell (``((echo a); echo b)``) fails to parse. Bash resolves the
    same ambiguity by trying the arithmetic command and reparsing as
    nested subshells when that fails; this does the same, splitting only
    the openers that already sit inside an error and keeping the retry
    only if it parses cleanly. Commands that parse today are untouched,
    so no working command's byte offsets move.

    Args:
        command (str): shell source to parse.

    Returns:
        tree_sitter.Node: root node, or the original errored root when no
        reparse helps.
    """
    data = strip_line_continuation(command).encode()
    root = TS_PARSER.parse(data).root_node
    if not root.has_error:
        return root
    # Sitting inside an ERROR is not evidence that an opener is broken:
    # tree-sitter's error region swallows neighbouring tokens, so a valid
    # `((i++))` next to a bad opener reports as errored too. Splitting it
    # would silently turn arithmetic into a subshell running `i++`, which
    # is a wrong parse rather than a rejected one. Each opener is judged
    # on its own span instead, in byte space throughout, because the
    # offsets tree-sitter reports are byte offsets.
    offsets = [
        offset for offset in set(_failed_arith_openers(root))
        if not _is_arithmetic(data, offset)
    ]
    if not offsets:
        return root
    for offset in sorted(offsets, reverse=True):
        data = data[:offset + 1] + b" " + data[offset + 1:]
    retried = TS_PARSER.parse(data).root_node
    return root if retried.has_error else retried


_BASH_KEYWORDS = frozenset({
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "for",
    "while",
    "until",
    "do",
    "done",
    "case",
    "esac",
    "in",
    "function",
    "select",
})

_STRUCTURAL_TOKENS = frozenset({
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    '"',
    "'",
    "`",
})


def _is_structural_error(node: tree_sitter.Node) -> bool:
    """True if an ERROR node represents a real syntactic problem.

    Tree-sitter occasionally emits ERROR nodes for stray statement
    separators that bash itself accepts (notably ``& ;``). A real
    syntax error contains a bash keyword, a bracket / quote token,
    or a named subtree the parser tried to recover; stand-alone
    statement separators (``;``, ``&``, ``|``) are not enough.
    """
    for child in node.children:
        if child.is_named:
            return True
        if child.type in _BASH_KEYWORDS:
            return True
        if child.type in _STRUCTURAL_TOKENS:
            return True
    return False


def _walk_named(node: tree_sitter.Node):
    yield node
    for child in node.named_children:
        yield from _walk_named(child)


def _is_recovered_quoted_heredoc_end(previous: tree_sitter.Node | None,
                                     error: tree_sitter.Node) -> bool:
    if previous is None:
        return False
    error_text = (error.text or b"").decode().strip()
    if not error_text:
        return False
    for candidate in _walk_named(previous):
        if candidate.type != "heredoc_redirect":
            continue
        start = None
        end = None
        for child in candidate.named_children:
            if child.type == "heredoc_start":
                start = (child.text or b"").decode()
            elif child.type == "heredoc_end":
                end = (child.text or b"").decode()
        if (start is not None and ("'" in start or '"' in start) and not end
                and start.replace("'", "").replace('"', "") == error_text):
            return True
    return False


def find_syntax_error(node: tree_sitter.Node) -> str | None:
    """Locate a top-level structural syntax error in a parsed AST.

    Args:
        node (tree_sitter.Node): root node from parse().

    Returns:
        str | None: text of the offending region, or None if the AST is clean.
    """
    if not node.has_error:
        return None
    previous = None
    for child in node.children:
        if child.is_missing:
            text = child.text
            return text.decode(errors="replace") if text else ""
        if child.type == "ERROR" and _is_structural_error(child):
            if _is_recovered_quoted_heredoc_end(previous, child):
                previous = child
                continue
            text = child.text
            return text.decode(errors="replace") if text else ""
        if child.is_named:
            previous = child
    return None
