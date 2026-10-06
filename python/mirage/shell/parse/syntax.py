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

from collections.abc import Callable, Iterator, Mapping, Sequence
from itertools import chain

from mirage.io import IOResult
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.constants import (
    BASH_KEYWORDS,
    CASE_TERMINATORS,
    SEPARATOR_TOKENS,
    STRUCTURAL_TOKENS,
)
from mirage.shell.parse.types import SourceSpan, SyntaxIssue
from mirage.shell.types import TSNodeLike


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


def _is_structural_error(node: TSNodeLike) -> bool:
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


def _stray_case_terminators(node: TSNodeLike) -> Iterator[tuple[int, str]]:
    """Each ``;;`` / ``;&`` / ``;;&`` token outside a case item.

    The grammar takes them as ordinary statement separators, so
    ``true;;s`` parses cleanly and would run ``s``; bash refuses the
    line at the token.

    Args:
        node (TSNodeLike): root node from parse().

    Yields:
        tuple[int, str]: the token's start byte and text.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        for child in current.children:
            if child.type in CASE_TERMINATORS and current.type != "case_item":
                text = child.text
                yield (
                    child.start_byte,
                    (decode_text(text) if text else child.type),
                )
            stack.append(child)


_BODY_OPENERS = ("do", "{", "then", "else")
_BODY_CLOSERS = ("done", "}", "fi", "elif", "else")


def _empty_compounds(node: TSNodeLike) -> Iterator[tuple[int, str]]:
    """Each token closing a compound list that holds no command.

    bash requires a command in every ``do``, ``then``, ``else`` and brace
    body (5.2: ``for x in a; do done`` is a syntax error near ``done``);
    the grammar accepts an empty one, comments aside.

    Args:
        node (TSNodeLike): root node from parse().

    Yields:
        tuple[int, str]: the closer's start byte and text.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        stack.extend(current.children)
        if current.type not in (
            "do_group",
            "compound_statement",
            "if_statement",
        ):
            continue
        opened = False
        for kid in (
            token
            for child in current.children
            for token in (
                child.children
                if child.type in ("elif_clause", "else_clause")
                else [child]
            )
        ):
            if opened and kid.type in _BODY_CLOSERS:
                yield (
                    kid.start_byte,
                    decode_text(kid.text or b""),
                )
            if kid.type in _BODY_OPENERS:
                opened = True
            elif kid.is_named and kid.type != "comment":
                opened = False


# Reserved words that close or continue a compound command; quoted,
# escaped, after an assignment or a redirect, or named as an alias the
# shell would expand there, they are plain words.
_RESERVED_CLOSERS = frozenset(
    {"do", "done", "elif", "else", "esac", "fi", "in", "then", "}", "]]"}
)


def _stray_reserved_words(
    node: TSNodeLike,
    aliases: frozenset[str],
    own: Mapping[str, tuple[int, int]],
    offsets: Sequence[int] | None,
) -> Iterator[tuple[int, str]]:
    """Each reserved word a command starts with, where none may stand.

    The grammar reads ``echo hi; fi`` as two commands and would run both;
    bash 5.2 refuses the line at ``fi``, as it does ``done``, ``then`` and
    the rest when they stand where a command starts. Inside ``$(...)`` and
    a process substitution, bash 5.2 takes such a word as reserved even
    when an alias spells it.

    Args:
        node (TSNodeLike): root node from parse().
        aliases (frozenset[str]): alias names the shell would expand where
            a command starts, which bash tries before reserved words.
        own (Mapping[str, tuple[int, int]]): each alias whose own text
            the line opens with, to the span of the line that text covers;
            a word spelled like the alias starting inside it is reserved,
            since an alias never expands within its own text.
        offsets (Sequence[int] | None): where each byte the parser read
            sits in that line, as ``source_offsets`` maps it; None where
            the two are the same.

    Yields:
        tuple[int, str]: the word's start byte and text.
    """
    stack = [(node, aliases)]
    while stack:
        current, names = stack.pop()
        if current.type == "process_substitution" or (
            current.type == "command_substitution"
            and not (current.text or b"").startswith(b"`")
        ):
            names = frozenset()
        stack.extend((child, names) for child in current.children)
        if current.type != "command" or not current.children:
            continue
        name = current.children[0]
        text = decode_text(name.text or b"")
        if name.type != "command_name" or text not in _RESERVED_CLOSERS:
            continue
        span = own.get(text)
        at = name.start_byte if offsets is None else offsets[name.start_byte]
        if text not in names or (span is not None and span[0] <= at < span[1]):
            yield name.start_byte, text


def _walk_named(node: TSNodeLike) -> Iterator[TSNodeLike]:
    # Malformed input can still contain deeply nested valid subtrees.
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.named_children))


def _is_recovered_quoted_heredoc_end(
    previous: TSNodeLike | None, error: TSNodeLike
) -> bool:
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


def _missing_quote(node: TSNodeLike) -> str | None:
    stack = [node]
    while stack:
        current = stack.pop()
        if current.is_missing and current.type in ("'", '"', "`"):
            return ""
        stack.extend(current.children)
    return None


def find_syntax_error(
    node: TSNodeLike,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
    parse_fn: Callable[[str], TSNodeLike] | None = None,
) -> str | None:
    found = find_syntax_issue(node, aliases, own, offsets, parse_fn)
    return None if found is None else found.offending


def _issue(node: TSNodeLike, offending: str | None) -> SyntaxIssue | None:
    return (
        None
        if offending is None
        else SyntaxIssue(offending, SourceSpan(node.start_byte, node.end_byte))
    )


def find_syntax_issue(
    node: TSNodeLike,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
    parse_fn: Callable[[str], TSNodeLike] | None = None,
) -> SyntaxIssue | None:
    """Locate structural errors and missing tokens throughout a parsed AST.

    Of the tokens the grammar accepts and bash refuses, the first on the
    line is the one reported, as bash stops there.

    Args:
        node (TSNodeLike): root node from parse().
        aliases (frozenset[str]): alias names the shell would expand where
            a command starts; a reserved word among them is a command.
        own (Mapping[str, tuple[int, int]] | None): each alias whose own
            text the line opens with, to the span of the line that text
            covers, inside which its name stays reserved.
        offsets (Sequence[int] | None): where each byte the parser read
            sits in that line (``source_offsets``); None where the two are
            the same.

    Returns:
        str | None: text of the offending region, or None if the AST is clean.
    """
    # Parameter syntax is judged during expansion (bad substitution), and
    # `[` is a builtin whose argument grammar is judged by that builtin.
    if node.type == "expansion":
        return (
            _issue(node, "")
            if any(c.is_missing and c.type == "}" for c in node.children)
            else None
        )
    if (
        node.type == "test_command"
        and node.children
        and node.children[0].type == "["
    ):
        return _issue(node, _missing_quote(node))
    if node.type == "command_substitution":
        source = decode_text(node.text or b"")
        unclosed = find_unterminated_backtick(source)
        if unclosed is not None:
            return _issue(node, unclosed)
        if (
            parse_fn is not None
            and source.startswith("$(")
            and source.endswith(")")
        ):
            nested = find_syntax_issue(
                parse_fn(source[2:-1]), parse_fn=parse_fn
            )
            return None if nested is None else _issue(node, nested.offending)
    stray = min(
        chain(
            _stray_case_terminators(node),
            _empty_compounds(node),
            _stray_reserved_words(node, aliases, own or {}, offsets),
        ),
        default=None,
    )
    if stray is not None:
        return SyntaxIssue(
            stray[1],
            SourceSpan(stray[0], stray[0] + len(encode_text(stray[1]))),
        )
    if not node.has_error:
        return _issue(node, find_unterminated_quote(node))
    previous = None
    for child in node.children:
        # Bash permits unquoted spaces in associative subscripts. The
        # grammar recovers their earlier plain words as ERROR children.
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
        if child.is_missing:
            text = child.text
            return _issue(child, decode_text(text) if text else "")
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
            text = child.text
            return _issue(child, decode_text(text) if text else "")
        if child.type != "ERROR":
            nested = find_syntax_issue(child, aliases, own, offsets, parse_fn)
            if nested is not None:
                return nested
        if child.is_named:
            previous = child
    return None


def find_unterminated_quote(node: TSNodeLike) -> str | None:
    """Find a missing quote in the parser's erroneous regions.

    Complete strings, comments and heredoc bodies remain opaque. The
    grammar represents an open double quote as a missing token or an
    ERROR child, and an open single quote as a leaf ERROR span. An ANSI-C
    string ending in an escaped quote can parse cleanly, so check its
    closing delimiter as well.

    Args:
        node (TSNodeLike): the parsed command being refused.
    """
    stack = [(node, False)]
    while stack:
        current, visited = stack.pop()
        if visited:
            # Diagnose an ERROR span only after its children, as before.
            if not current.children and (current.text or b"").startswith(b"'"):
                return "'"
            if sum(child.type == '"' for child in current.children) % 2:
                return '"'
            continue
        if current.is_missing and current.type in ("'", '"'):
            return current.type
        if current.type == "ansi_c_string":
            source = decode_text(current.text or b"")
            before = source[:-1]
            if (len(before) - len(before.rstrip("\\"))) % 2:
                return "'"
            continue
        if current.type == "ERROR":
            stack.append((current, True))
        stack.extend((child, False) for child in reversed(current.children))
    return None


def syntax_error_result(
    offending: str, node: TSNodeLike | None = None
) -> IOResult:
    """Exit 2 with the bash-style diagnostic for an unparsable line.

    Args:
        offending (str): the span the parser flagged.
        node (TSNodeLike | None): the parsed command, for quote diagnostics.
    """
    quote = find_unterminated_quote(node) if node is not None else None
    snippet = offending.strip()
    if quote is not None:
        message = (
            f"mirage: unexpected EOF while looking for matching `{quote}'\n"
        )
    elif snippet:
        message = f"mirage: syntax error near '{snippet}'\n"
    else:
        message = "mirage: syntax error in command\n"
    return IOResult(exit_code=2, stderr=encode_text(message))
