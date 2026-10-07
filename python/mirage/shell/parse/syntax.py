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
    ASSIGNMENT_OPERATORS,
    BASH_KEYWORDS,
    CASE_TERMINATORS,
    CLOSING_TOKENS,
    COMMAND_FOLLOWS,
    COMPOUND_CLOSERS,
    CONSTRUCT_CLOSERS,
    LIST_OPERATORS,
    NAME_FOLLOWS,
    OPENER_CLOSERS,
    QUOTE_TOKENS,
    SEPARATOR_TOKENS,
    STRUCTURAL_TOKENS,
)
from mirage.shell.parse.types import SourceSpan, SyntaxIssue
from mirage.shell.types import NodeType as NT
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
        if _reserved_here(text, name.start_byte, names, own, offsets):
            yield name.start_byte, text


def _reserved_here(
    word: str,
    start: int,
    aliases: frozenset[str],
    own: Mapping[str, tuple[int, int]] | None,
    offsets: Sequence[int] | None,
) -> bool:
    """Whether a closing word where a command starts is the reserved word:
    it is unless an alias spells it, and an alias never expands inside
    its own text.

    Args:
        word (str): the word.
        start (int): its start byte in the parse.
        aliases (frozenset[str]): as in ``find_syntax_issue``.
        own (Mapping[str, tuple[int, int]] | None): as in
            ``find_syntax_issue``.
        offsets (Sequence[int] | None): as in ``find_syntax_issue``.
    """
    if word not in aliases:
        return True
    span = (own or {}).get(word)
    at = start if offsets is None else offsets[start]
    return span is not None and span[0] <= at < span[1]


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
    parse_fn: Callable[[str], TSNodeLike] | None = None,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
) -> str | None:
    found = find_syntax_issue(node, parse_fn, aliases, own, offsets)
    return None if found is None else found.offending


def _issue(node: TSNodeLike, offending: str | None) -> SyntaxIssue | None:
    return (
        None
        if offending is None
        else SyntaxIssue(offending, SourceSpan(node.start_byte, node.end_byte))
    )


def find_syntax_issue(
    node: TSNodeLike,
    parse_fn: Callable[[str], TSNodeLike] | None = None,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
) -> SyntaxIssue | None:
    """Locate structural errors and missing tokens throughout a parsed AST.

    Of the tokens the grammar accepts and bash refuses, the first on the
    line is the one reported, as bash stops there. An error the walk finds
    only by reparsing a ``$(...)`` body spans that substitution, since the
    reparse reads the body in its own coordinates; one the walk sees
    directly, such as a stray ``fi`` inside the body, keeps its own span.

    Args:
        node (TSNodeLike): root node from parse().
        parse_fn (Callable[[str], TSNodeLike] | None): parses the body of
            a ``$(...)`` substitution so its own syntax is judged too;
            None leaves substitution bodies unchecked.
        aliases (frozenset[str]): alias names the shell would expand where
            a command starts; a reserved word among them is a command.
        own (Mapping[str, tuple[int, int]] | None): each alias whose own
            text the line opens with, to the span of the line that text
            covers, inside which its name stays reserved.
        offsets (Sequence[int] | None): where each byte the parser read
            sits in that line (``source_offsets``); None where the two are
            the same.

    Returns:
        SyntaxIssue | None: the offending region's text and span, or None
        if the AST is clean.
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
            nested = find_syntax_issue(parse_fn(source[2:-1]), parse_fn)
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
            nested = find_syntax_issue(child, parse_fn, aliases, own, offsets)
            if nested is not None:
                return nested
        if child.is_named:
            previous = child
    return None


def find_unterminated_quote(node: TSNodeLike) -> str | None:
    """Find what the input ended inside: a quote, or a substitution or
    expansion still waiting for its closer.

    Complete strings, comments and heredoc bodies remain opaque. The
    grammar represents an open double quote as a missing token or an
    ERROR child, and an open single quote as a leaf ERROR span. An ANSI-C
    string ending in an escaped quote can parse cleanly, so check its
    closing delimiter as well. An unclosed ``$(``, ``$((``, ``<(``,
    ``>(``, ``${`` or ``$[`` is an opener token in an ERROR, or a
    substitution or expansion whose closer the grammar marks missing.

    Args:
        node (TSNodeLike): the parsed command being refused.

    Returns:
        str | None: the character bash reports it was looking for.
    """
    found = _unfinished(node)
    return None if found is None or found[3] else found[0]


def _unfinished(node: TSNodeLike) -> tuple[str, str, int, bool] | None:
    """What the input ended inside, as ``find_unterminated_quote`` reads
    it: the character bash names for the innermost construct left open,
    the kind and start of the outermost one, which an unexpected token
    before it is reported ahead of, and whether an operator cut that
    construct short instead, the first item then being that operator: an
    array assignment's ``(`` takes only words up to its ``)``
    (``_array_cut``).

    Args:
        node (TSNodeLike): the parsed command being refused.
    """
    end = node.start_byte + len((node.text or b"").rstrip())
    stack: list[tuple[TSNodeLike, bool, int | None]] = [(node, False, None)]
    while stack:
        current, visited, quoted = stack.pop()
        if visited:
            # Diagnose an ERROR span only after its children, as before.
            if not current.children and (current.text or b"").startswith(b"'"):
                return "'", "'", current.start_byte, False
            pending = _unclosed(current.children)
            if pending:
                return pending[-1][1], pending[0][2], pending[0][3], False
            continue
        if current.is_missing and current.type in QUOTE_TOKENS:
            opened = current.parent if current.parent is not None else current
            return current.type, current.type, opened.start_byte, False
        if current.type == NT.ARRAY:
            cut = _array_cut(current, node, end)
            if cut is not None:
                return cut, NT.ARRAY, current.start_byte, True
        closer = CONSTRUCT_CLOSERS.get(current.type)
        if closer is not None and any(
            child.is_missing and child.type in CLOSING_TOKENS
            for child in current.children
        ):
            # Inside a double-quoted string, bash reads the string's own
            # closing quote into the construct, where it opens another.
            if quoted is not None:
                return '"', NT.STRING, quoted, False
            return closer, current.type, current.start_byte, False
        if current.type == "ansi_c_string":
            source = decode_text(current.text or b"")
            before = source[:-1]
            if (len(before) - len(before.rstrip("\\"))) % 2:
                return "'", current.type, current.start_byte, False
            continue
        if current.type == "ERROR":
            stack.append((current, True, quoted))
        inner = (
            current.start_byte
            if quoted is None and current.type == NT.STRING
            else quoted
        )
        stack.extend(
            (child, False, inner) for child in reversed(current.children)
        )
    return None


def _unclosed(
    children: Sequence[TSNodeLike],
) -> list[tuple[str, str, str, int]] | None:
    """The constructs an ERROR's tokens leave open, outermost first: each
    one's closing token, the character bash names for it, its opener and
    its start.

    A double quote or a backtick nests inside a substitution as bash reads
    it (``"$("`` waits for a quote), a lone ``)`` inside ``$((`` groups
    rather than closes, and a ``(`` right after an assignment's ``=``
    opens an array. Any other closer that does not match the innermost
    opener is an unexpected token rather than the end of input, as is a
    ``(`` inside an array: None.

    Args:
        children (Sequence[TSNodeLike]): the ERROR node's children, in order.
    """
    pending: list[tuple[str, str, str, int]] = []
    previous: TSNodeLike | None = None
    for child in children:
        kind = child.type
        start = child.start_byte
        if kind in ('"', "`"):
            if pending and pending[-1][0] == kind:
                pending.pop()
            else:
                pending.append((kind, kind, kind, start))
        elif kind in OPENER_CLOSERS:
            pending.append((*OPENER_CLOSERS[kind], kind, start))
        elif (
            kind == "("
            and previous is not None
            and previous.type in ASSIGNMENT_OPERATORS
        ):
            pending.append((")", ")", NT.ARRAY, start))
        elif kind == "(" and pending and pending[-1][2] == NT.ARRAY:
            return None
        elif kind in CLOSING_TOKENS and pending:
            if not (kind == ")" and pending[-1][0] == "))"):
                if kind != pending[-1][0]:
                    return None
                pending.pop()
        previous = child
    return pending


def _array_cut(array: TSNodeLike, root: TSNodeLike, end: int) -> str | None:
    """The operator that cut an array assignment's ``(`` short: bash reads
    only words up to its ``)`` and reports the first other token, one the
    grammar refused inside the array (``>``), or the one after the ``)``
    it marks missing before the input ends (``;``).

    Args:
        array (TSNodeLike): the array.
        root (TSNodeLike): the parsed line.
        end (int): where the line's text ends.
    """
    stack = list(reversed(array.children))
    while stack:
        current = stack.pop()
        if current.type == "ERROR":
            return _token_after(current, current.start_byte)
        if current.type not in CONSTRUCT_CLOSERS and current.type != NT.STRING:
            stack.extend(reversed(current.children))
    closer = array.children[-1] if array.children else None
    if closer is None or not closer.is_missing or closer.start_byte >= end:
        return None
    return _token_after(root, closer.start_byte)


def _token_after(node: TSNodeLike, at: int) -> str | None:
    """The first token of a parse from a byte on, comments aside: what
    bash reads next there.

    Args:
        node (TSNodeLike): the parse.
        at (int): the byte.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        if (
            current.end_byte <= at
            or current.is_missing
            or current.type == "comment"
        ):
            continue
        if current.children:
            stack.extend(reversed(current.children))
        elif current.start_byte >= at:
            return decode_text(current.text or b"")
    return None


def fails_in_array(node: TSNodeLike, issue_end: int | None = None) -> bool:
    """Whether the first error bash reads is inside an array assignment's
    ``(``, the outermost construct the input leaves open or one an
    operator cuts short: bash's ``parse_compound_assignment`` refuses that
    line with status 1 and discards it, where any other syntax error has
    status 2.

    Args:
        node (TSNodeLike): the parsed line.
        issue_end (int | None): where the reported error ends; a token
            ending before the array opens is the error bash reports.
    """
    found = _unfinished(node)
    return (
        found is not None
        and found[1] == NT.ARRAY
        and (issue_end is None or issue_end > found[2])
    )


def ends_inside_construct(
    node: TSNodeLike,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
    issue_end: int | None = None,
) -> bool:
    """Whether the input ends inside a compound command or after an operator.

    bash reads such a line as unfinished when it took every token where
    it stood and still wants more: the grammar marks the token it needed
    missing at the end (``(echo a``, ``echo a |``), or an ERROR reaching
    the end leaves a compound open (``{ echo a``, ``if true; then``,
    ``case a in``). A token it could not take (``if then``, ``if ;``,
    ``( then``) is the error bash reports instead, as is a flagged span
    ending before the unfinished construct starts; a closing reserved
    word an alias spells is a command there.

    Args:
        node (TSNodeLike): the parsed line.
        aliases (frozenset[str]): as in ``find_syntax_issue``.
        own (Mapping[str, tuple[int, int]] | None): as in
            ``find_syntax_issue``.
        offsets (Sequence[int] | None): as in ``find_syntax_issue``.
        issue_end (int | None): where the flagged span ends in the parse;
            None when it is not known.
    """
    stray = chain(
        _stray_case_terminators(node),
        _empty_compounds(node),
        _stray_reserved_words(node, aliases, own or {}, offsets),
    )
    if any(text for _, text in stray):
        return False
    end = node.start_byte + len((node.text or b"").rstrip())
    unfinished = False
    stack: list[tuple[TSNodeLike, TSNodeLike | None, TSNodeLike]] = [
        (node, None, node)
    ]
    while stack:
        current, before, parent = stack.pop()
        if current.type == "ERROR":
            opened = _open_compound(
                current, before, parent, aliases, own, offsets
            )
            if opened is None:
                return False
            at_end = opened and current.end_byte >= end
        else:
            at_end = current.is_missing and current.start_byte >= end
        if at_end and (issue_end is None or issue_end >= current.start_byte):
            unfinished = True
        previous = None
        for child in current.children:
            stack.append((child, previous, current))
            previous = child
    return unfinished


def _open_compound(
    error: TSNodeLike,
    before: TSNodeLike | None,
    parent: TSNodeLike,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
) -> bool | None:
    """Read an ERROR's tokens as bash does: whether they leave a compound
    open, or None at the first token bash cannot take where it stands.

    A command must follow the tokens in ``COMMAND_FOLLOWS``, a function's
    ``()`` and, at the top of the line, where nothing is open, a
    separator (a newline among them); a word must follow those in
    ``NAME_FOLLOWS``. A list
    operator, a ``)`` or a closing reserved word is unexpected where a
    command must come, as is a list operator right after another, and at
    the top of the line a ``)`` closing nothing. After a command's words a
    ``(`` is unexpected unless ``()`` makes the command a function
    definition. After a case's ``in`` the grammar groups each whole
    ``pattern)`` item, so any other token but ``esac`` is a pattern still
    waiting for its ``)``. Text the grammar skipped is unexpected too. A
    nested ERROR's tokens are read in line, as tokens the grammar could
    not group.

    Args:
        error (TSNodeLike): the ERROR node.
        before (TSNodeLike | None): its previous sibling; after a
            command, the node starts among that command's words.
        parent (TSNodeLike): the node holding it.
        aliases (frozenset[str]): as in ``find_syntax_issue``.
        own (Mapping[str, tuple[int, int]] | None): as in
            ``find_syntax_issue``.
        offsets (Sequence[int] | None): as in ``find_syntax_issue``.
    """
    text = error.text or b""
    children = list(_error_tokens(error))
    top = parent.type == "program"
    after = None if before is None else before.type
    if before is not None:
        gap = (parent.text or b"")[
            before.end_byte - parent.start_byte : error.start_byte
            - parent.start_byte
        ]
        if b"\n" in gap.replace(b"\\\n", b""):
            after = ";"
    if after == "command":
        expect = "words"
    elif (
        after in COMMAND_FOLLOWS
        or (top and (after is None or after in SEPARATOR_TOKENS))
        or (after == ")" and parent.type == "function_definition")
    ):
        expect = "command"
    elif after in SEPARATOR_TOKENS:
        expect = "list"
    else:
        expect = ""
    pending: list[str] = []
    cursor = error.start_byte
    for i, child in enumerate(children):
        kind = child.type
        skipped = text[
            cursor - error.start_byte : child.start_byte - error.start_byte
        ]
        word = decode_text(child.text or b"") if child.is_named else kind
        if (
            skipped.strip()
            or (
                expect == "items"
                and kind not in ("case_item", "esac", "comment")
            )
            or (
                expect in ("command", "name", "list")
                and kind in LIST_OPERATORS
            )
            or (
                kind == ")"
                and (
                    expect == "command"
                    or (top and not pending and expect != "call")
                )
            )
            or (
                expect == "command"
                and word in _RESERVED_CLOSERS
                and _reserved_here(
                    word, child.start_byte, aliases, own, offsets
                )
            )
        ):
            return None
        call = expect == "words" and kind == "("
        if call and (i + 1 == len(children) or children[i + 1].type != ")"):
            return None
        closer = None if call else COMPOUND_CLOSERS.get(kind)
        if closer is not None:
            pending.append(closer)
        elif pending and kind == pending[-1]:
            pending.pop()
        if call:
            expect = "call"
        elif expect == "call":
            expect = "command"
        elif (expect == "items" and kind != "esac") or (
            kind == "in" and pending and pending[-1] == "esac"
        ):
            expect = "items"
        elif kind in COMMAND_FOLLOWS:
            expect = "command"
        elif kind in NAME_FOLLOWS:
            expect = "name"
        elif kind in LIST_OPERATORS:
            expect = "list"
        else:
            expect = "words"
        cursor = child.end_byte
    if text[cursor - error.start_byte :].strip():
        return None
    return bool(pending)


def _error_tokens(error: TSNodeLike) -> Iterator[TSNodeLike]:
    """An ERROR's children, a nested ERROR's read in line.

    Args:
        error (TSNodeLike): the ERROR node.
    """
    for child in error.children:
        if child.type == "ERROR":
            yield from _error_tokens(child)
        else:
            yield child


def syntax_error_result(
    offending: str,
    node: TSNodeLike | None = None,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
    issue_end: int | None = None,
) -> IOResult:
    """The bash-style diagnostic for an unparsable line: status 2, or 1
    for an array assignment it fails inside (``fails_in_array``).

    Args:
        offending (str): the span the parser flagged.
        node (TSNodeLike | None): the parsed command, for quote diagnostics.
        aliases (frozenset[str]): as in ``find_syntax_issue``.
        own (Mapping[str, tuple[int, int]] | None): as in
            ``find_syntax_issue``.
        offsets (Sequence[int] | None): as in ``find_syntax_issue``.
        issue_end (int | None): where the flagged span ends in the parse.
    """
    message = syntax_error_message(
        offending, node, aliases, own, offsets, issue_end
    )
    array = node is not None and fails_in_array(node, issue_end)
    return IOResult(exit_code=1 if array else 2, stderr=encode_text(message))


def syntax_error_message(
    offending: str,
    node: TSNodeLike | None = None,
    aliases: frozenset[str] = frozenset(),
    own: Mapping[str, tuple[int, int]] | None = None,
    offsets: Sequence[int] | None = None,
    issue_end: int | None = None,
) -> str:
    """Format the diagnostic shared by parsed programs and execution results.

    bash reports the first error it reads: input left open inside a quote
    or construct is the error unless the flagged span ends before that
    construct opens (``fi; echo "a`` is the unexpected ``fi``), and an
    operator cutting an array short is the token it reports (``x=(1 2;
    fi`` is the unexpected ``;``).

    Args:
        offending (str): the span the parser flagged.
        node (TSNodeLike | None): the parsed command, for quote diagnostics.
        aliases (frozenset[str]): as in ``find_syntax_issue``.
        own (Mapping[str, tuple[int, int]] | None): as in
            ``find_syntax_issue``.
        offsets (Sequence[int] | None): as in ``find_syntax_issue``.
        issue_end (int | None): where the flagged span ends in the parse;
            None when it is not known.
    """
    found = _unfinished(node) if node is not None else None
    if found is not None and issue_end is not None and issue_end <= found[2]:
        found = None
    if found is not None and found[3]:
        return f"mirage: syntax error near '{found[0]}'\n"
    quote = None if found is None else found[0]
    if quote is None and find_unterminated_backtick(offending) is not None:
        quote = "`"
    snippet = offending.strip()
    if quote is not None:
        return f"mirage: unexpected EOF while looking for matching `{quote}'\n"
    if node is not None and ends_inside_construct(
        node, aliases, own, offsets, issue_end
    ):
        return "mirage: syntax error: unexpected end of file\n"
    if snippet:
        return f"mirage: syntax error near '{snippet}'\n"
    return "mirage: syntax error in command\n"
