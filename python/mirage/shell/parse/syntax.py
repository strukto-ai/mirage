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

from collections.abc import Iterator

import tree_sitter

from mirage.io import IOResult
from mirage.shell.parse.constants import (BASH_KEYWORDS, CASE_TERMINATORS,
                                          SEPARATOR_TOKENS, STRUCTURAL_TOKENS)


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


def _is_structural_error(node: tree_sitter.Node) -> bool:
    """True if an ERROR node represents a real syntactic problem.

    A real syntax error contains a bash keyword, a bracket / quote
    token, a statement separator, or a named subtree the parser tried
    to recover. A separator inside an ERROR node has nothing to
    separate (``;s``, ``| s``, ``a ; ; b``, ``a &; b``), and GNU bash
    5.2 refuses every such line with ``syntax error near unexpected
    token``; an earlier reading that bash accepts ``& ;`` was wrong.
    """
    for child in node.children:
        if child.is_named:
            return True
        if child.type in BASH_KEYWORDS:
            return True
        if child.type in STRUCTURAL_TOKENS:
            return True
        if child.type in SEPARATOR_TOKENS:
            return True
    return False


def _stray_case_terminator(node: tree_sitter.Node) -> str | None:
    """The text of a ``;;`` / ``;&`` / ``;;&`` token outside a case item.

    The grammar takes them as ordinary statement separators, so
    ``true;;s`` parses cleanly and would run ``s``; bash refuses the
    line at the token.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    stack = [node]
    while stack:
        current = stack.pop()
        for child in current.children:
            if child.type in CASE_TERMINATORS and current.type != "case_item":
                text = child.text
                return text.decode(errors="replace") if text else child.type
            stack.append(child)
    return None


def _walk_named(node: tree_sitter.Node) -> Iterator[tree_sitter.Node]:
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
    stray = _stray_case_terminator(node)
    if stray is not None:
        return stray
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


def syntax_error_result(offending: str) -> IOResult:
    """Exit 2 with the bash-style diagnostic for an unparsable line.

    Args:
        offending (str): the span the parser flagged.
    """
    snippet = offending.strip()
    err = (f"mirage: syntax error near {snippet!r}\n".encode()
           if snippet else b"mirage: syntax error in command\n")
    return IOResult(exit_code=2, stderr=err)
