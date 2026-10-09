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

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parameter import scan_parameter
from mirage.shell.parse.constants import ARITH_OPEN_TOKEN, QUOTES
from mirage.shell.parse.engine import TS_PARSER
from mirage.shell.parse.expansion import expansion_source
from mirage.shell.parse.heredoc import protected_source
from mirage.shell.parse.heredoc.reader import delimiter_end
from mirage.shell.parse.source import SourceNode
from mirage.shell.types import TSNodeLike


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
        char = data[index : index + 1]
        if quote is not None:
            if char == b"\\" and quote == b'"':
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char in QUOTES:
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


def is_arithmetic(data: bytes, start: int) -> bool:
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


_UNLEXED = frozenset(
    {
        "test_command",
        "arithmetic_expansion",
        "string_content",
        "raw_string",
        "ansi_c_string",
        "expansion",
        "heredoc_content",
        "comment",
        "binary_expression",
        "unary_expression",
        "postfix_expression",
    }
)


_WORD_START = b" \t\n;&|(){}"


_DIGITS = re.compile(rb"\d+")


_ESCAPED_BLANK = re.compile(rb"\\[ \t]")


_LAST_ARM = re.compile(rb"\s*esac(?![^\s;&|()<>])")

# Tokens the grammar lexes apart from a word in an argument list, where
# bash reads a word, by the node they stand under. A bare `$` in a command
# is already kept as a word, and only an error region loses it; the `$`
# opening `$"..."` is the translation marker, never a word.
_BARE_WORDS = {
    "command": frozenset({"==", "=~"}),
    "ERROR": frozenset({"==", "=~", "$"}),
}


_WORD_BREAK = b" \t\n;&|()<>"


_LIST_TOKENS = frozenset({"&&", "||", "|", "|&", ";", "&", ";;"})


_TEST_PARTS = frozenset(
    {
        "binary_expression",
        "unary_expression",
        "negation_expression",
        "parenthesized_expression",
        "ERROR",
    }
)


def _breaks_word(data: bytes, at: int) -> bool:
    """Whether ``data[at]`` ends a word: the end, a blank or an operator.

    Args:
        data (bytes): shell source.
        at (int): byte offset, which may fall outside ``data``.
    """
    return at < 0 or at >= len(data) or data[at : at + 1] in _WORD_BREAK


def _bracket_is_a_command(data: bytes, node: TSNodeLike) -> bool:
    """Whether bash reads a ``[ ... ]`` the grammar built as a test as a command.

    ``[`` is a command to bash: its words end at the first list or pipe
    operator, and the last of them has to be a ``]`` of its own. The
    grammar folds ``&&``, ``||`` and ``|`` into the expression, closes it
    at a ``]`` that bash reads inside ``]]`` or ``]x``, and builds one
    whose ``]`` is missing; bash runs the builtin on each, which refuses
    with ``[: missing `]'``.

    Args:
        data (bytes): shell source.
        node (TSNodeLike): a ``test_command`` node.
    """
    children = node.children
    if not children or children[0].type != "[":
        return False
    close = children[-1]
    if close.type != "]" or close.is_missing:
        return True
    if not _breaks_word(data, close.end_byte):
        return True
    stack = list(children[1:-1])
    while stack:
        part = stack.pop()
        if not part.is_named and part.type in _LIST_TOKENS:
            return True
        if part.type in _TEST_PARTS:
            stack.extend(part.children)
    return False


def operator_source(data: bytes, root: TSNodeLike) -> bytes:
    """Spell operators the way the grammar can lex them.

    bash reads ``<>`` and ``<<<`` as one operator each, and a digit
    string that starts a word and touches ``<`` or ``>`` as the
    descriptor. tree-sitter-bash reads ``<>`` as ``<`` then ``>``,
    ``<<<`` after a compound command or a descriptor as ``<<`` then
    ``<``, and a digit string with a leading zero (``0<f``) as a
    number. The same-width spelling here hands it ``>>``, ``<  `` and a
    nonzero first digit; ``SourceNode`` reads the original bytes, so a
    redirect whose text opens with ``<<<`` is the herestring it was. A
    last case arm's ``;&`` or ``;;&``, which the grammar refuses, ends it
    as ``;;`` does, there being no arm after it, so it is spelled so. An
    argument of ``==`` or ``=~``, which the grammar reads as a test
    operator wanting an operand (so ``echo ==`` is an error and
    ``echo == x`` drops it), and a bare ``$`` before a terminator are
    words to bash; spelled as ``_`` filler they parse as the words they
    are, and ``SourceNode`` gives back their text. So is the ``[`` of a
    test bash reads as a ``[`` command (``_bracket_is_a_command``, or one
    an error region opens), which then runs as the builtin, and so is a
    backslash-blank pair the grammar skips as whitespace
    (``_skipped_escapes``), spelled ``..`` so it opens its word without
    joining a ``$name`` before it or making an assignment. An operator
    inside an error region gets its own token only once the operators
    before it are respelled, so the pass repeats on its own parse until
    nothing changes.

    Args:
        data (bytes): shell source.
        root (TSNodeLike): the parse of ``data``.
    """
    lexed = _respelled(data, root)
    while lexed != data:
        data = lexed
        lexed = _respelled(data, TS_PARSER.parse(data).root_node)
    return data


def _skipped_escapes(data: bytes, root: TSNodeLike) -> list[int]:
    """Offsets of each backslash-blank pair the grammar read as a blank.

    Outside quotes, bash reads a backslash before a space or a tab as that
    blank escaped into the word it opens (``\\ x`` is the word `` x``).
    The grammar skips the pair as whitespace, so the word loses its blank,
    and a line one opens reads as more words of the line before. Only the
    bytes no token covers are searched; a quoted or unlexed span counts as
    one token.

    Args:
        data (bytes): shell source.
        root (TSNodeLike): the parse of ``data``.
    """
    if _ESCAPED_BLANK.search(data) is None:
        return []
    spans: list[tuple[int, int]] = [(len(data), len(data))]
    stack = [root]
    while stack:
        node = stack.pop()
        if node.children and node.type not in _UNLEXED | {"string"}:
            stack.extend(node.children)
        else:
            spans.append((node.start_byte, node.end_byte))
    offsets: list[int] = []
    at = 0
    for lo, hi in sorted(spans):
        offsets.extend(
            m.start() for m in _ESCAPED_BLANK.finditer(data, at, lo)
        )
        at = max(at, hi)
    return offsets


def _respelled(data: bytes, root: TSNodeLike) -> bytes:
    out = bytearray(data)
    for at in _skipped_escapes(data, root):
        out[at : at + 2] = b".."
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type == "test_command" and _bracket_is_a_command(data, node):
            out[node.start_byte] = ord("_")
        if node.type in _UNLEXED:
            continue
        stack.extend(node.children)
        for child in node.children:
            lo, hi = child.start_byte, child.end_byte
            if child.is_named:
                continue
            if child.type in _BARE_WORDS.get(node.type, ()) and not (
                child.type == "$" and data[hi : hi + 1] == b'"'
            ):
                out[lo:hi] = b"_" * (hi - lo)
            elif (
                node.type == "ERROR"
                and child.type == "["
                and _breaks_word(data, lo - 1)
                and _breaks_word(data, hi)
            ):
                out[lo] = ord("_")
        start = node.start_byte
        if node.type == "<" and data[start : start + 2] == b"<>":
            out[start] = ord(">")
        elif node.type in ("<<<", "<<") and data[start : start + 3] == b"<<<":
            out[start + 1 : start + 3] = b"  "
        elif node.type in (";&", ";;&") and _LAST_ARM.match(
            data, node.end_byte
        ):
            out[start : node.end_byte] = b";;".ljust(node.end_byte - start)
        digits = None if node.children else _DIGITS.match(data, start)
        if (
            digits is not None
            and data[start] == ord("0")
            and data[digits.end() : digits.end() + 1] in (b"<", b">")
            and (start == 0 or data[start - 1] in _WORD_START)
        ):
            out[start] = ord("1")
    return bytes(out)


def parse_protected(data: bytes) -> TSNodeLike:
    """Parse structure using same-width lexical shields.

    Heredoc bodies, substring operands and redirect operators need word
    grammar where tree-sitter's lexer otherwise rejects them. The shielded
    tree is read against the original bytes (``SourceNode``), retaining
    every source span. When shielding adds an error, keep the original
    parse so a real structural error still reaches syntax validation.

    Args:
        data (bytes): encoded shell source.
    """
    tree = TS_PARSER.parse(data)
    shielded_data = (
        protected_source(data, tree.root_node) if b"<<" in data else None
    ) or data
    shielded_data = expansion_source(shielded_data, tree.root_node)
    shielded_data = operator_source(shielded_data, tree.root_node)
    if shielded_data == data:
        return tree.root_node
    shielded = TS_PARSER.parse(shielded_data).root_node
    if not _errors(shielded) <= _errors(tree.root_node):
        return tree.root_node
    return SourceNode(shielded, data)


def failed_arith_openers(root: TSNodeLike) -> list[int]:
    """Byte offsets of ``((`` tokens the parser could not make sense of.

    Only openers inside an ERROR subtree, or opening a construct that
    holds one (``((exit 3) & a=$!; ...)`` lexes as arithmetic up to the
    error), are reported. A genuine ``((i++))`` parses as an arithmetic
    command with no error in it, so it cannot be picked up here.

    Args:
        root (TSNodeLike): root of a tree that has an error.
    """
    offsets: list[int] = []
    stack: list[tuple[TSNodeLike, bool]] = [(root, False)]
    while stack:
        node, in_error = stack.pop()
        errored = in_error or node.type == "ERROR"
        for child in node.children:
            if child.type == ARITH_OPEN_TOKEN and (errored or node.has_error):
                offsets.append(child.start_byte)
            stack.append((child, errored))
    return offsets


def _orphaned_dollar_offsets(root: TSNodeLike, data: bytes) -> list[int]:
    """Byte offsets of literal ``$`` tokens cut off from their name.

    tree-sitter-bash 0.25.1 stops lexing a later unbraced expansion in a
    word when a name-terminating character follows it, so
    ``> /api/$c/$id.json`` parses as ``/api/$c/$`` plus a sibling word
    ``id.json``: the ``$`` lands in the tree as a literal token and the
    expansion is gone. A literal ``$`` starting a recognized unbraced
    parameter is a shape no correct bash lex produces (bash would have
    read an expansion), so each one marks a mis-parse. The ``$`` opening
    a simple_expansion is that expansion's own token and is skipped.

    Args:
        root (TSNodeLike): root of the parsed tree.
        data (bytes): the source the tree was parsed from.
    """
    offsets: list[int] = []
    stack = [root]
    while stack:
        node = stack.pop()
        for child in node.children:
            if (
                not child.is_named
                and child.type == "$"
                and node.type != "simple_expansion"
                and data[child.end_byte : child.end_byte + 1] != b"{"
                and scan_parameter(decode_text(data[child.start_byte :]), 0)
                is not None
            ):
                offsets.append(child.start_byte)
            stack.append(child)
    return offsets


def _rebrace_dollar(data: bytes, offset: int) -> bytes:
    """Rewrite the expansion at ``offset`` into its braced spelling.

    ``$id.json`` becomes ``${id}.json``, which says the same thing and
    is the spelling the grammar reads correctly. Bash reads a single
    digit after ``$`` as one positional parameter, so ``$12`` rebraces
    as ``${1}2``.

    Args:
        data (bytes): shell source holding the orphaned ``$``.
        offset (int): byte offset of the ``$``.
    """
    ref = scan_parameter(decode_text(data[offset:]), 0)
    if ref is None:
        return data
    name, consumed = ref
    # References contain only ASCII, so their character and byte lengths
    # agree even when the source before or after them is multibyte.
    return (
        data[:offset]
        + b"${"
        + encode_text(name)
        + b"}"
        + data[offset + consumed :]
    )


def repair_orphaned_dollars(root: TSNodeLike, data: bytes) -> TSNodeLike:
    """Rebrace mis-lexed expansions and reparse until none remain.

    Every rebrace consumes one bare ``$`` and never writes a new one,
    so the loop is bounded by the count of ``$`` bytes. A retry that
    parses worse than what it replaces is discarded.

    Args:
        root (TSNodeLike): tree parsed from ``data``.
        data (bytes): the source ``root`` was parsed from.
    """
    for _ in range(data.count(b"$")):
        offsets = _orphaned_dollar_offsets(root, data)
        if not offsets:
            break
        for offset in sorted(offsets, reverse=True):
            data = _rebrace_dollar(data, offset)
        retried = parse_protected(data)
        if retried.has_error:
            break
        root = retried
    return root


def repair_redirect_dashes(
    root: TSNodeLike, data: bytes
) -> tuple[TSNodeLike, bytes]:
    # tree-sitter-bash drops a bare dash immediately before an explicit fd.
    # Quote only a dash in an uncovered gap, never text inside a word/body.
    offsets: list[int] = []
    stack = [root]
    while stack:
        node = stack.pop()
        end = node.start_byte
        for child in node.children:
            gap = data[end : child.start_byte]
            if child.type == "file_redirect" and gap.strip() == b"-":
                offsets.append(end + gap.index(b"-"))
            end = child.end_byte
            stack.append(child)
    if not offsets:
        return root, data
    repaired = data
    for offset in sorted(set(offsets), reverse=True):
        repaired = repaired[:offset] + b"'-'" + repaired[offset + 1 :]
    retried = parse_protected(repaired)
    return (root, data) if retried.has_error else (retried, repaired)


_NAME = re.compile(rb"\w+")


_FOLLOWER = re.compile(rb"\s*(in|do)(?![^\s;&|()<>])")


def _header_inserts(root: TSNodeLike, data: bytes) -> list[tuple[int, bytes]]:
    heads: list[int] = []
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type in ("for_statement", "ERROR"):
            heads.extend(
                kid.end_byte
                for kid in node.children
                if kid.type in ("for", "select")
            )
    inserts: list[tuple[int, bytes]] = []
    for head in heads:
        start = len(data) - len(data[head:].lstrip(b" \t"))
        end = delimiter_end(data, start) or start
        follower = _FOLLOWER.match(data, end)
        word = follower.group(1) if follower else None
        named = _NAME.fullmatch(data, start, end) is not None
        if end == start or named and word == b"in":
            continue
        tail = b";" if word == b"do" else b""
        inserts += (
            [(end, b' in "$@"' + tail)]
            if named
            else [(start, b"0 in "), (end, tail)]
        )
    return inserts


def repair_for_headers(
    root: TSNodeLike, data: bytes
) -> tuple[TSNodeLike, bytes]:
    # Encode invalid names for runtime validation and supply omitted "$@".
    # Repeat to expose nested headers; accept only repairs adding no errors.
    repaired, retried = data, root
    while inserts := _header_inserts(retried, repaired):
        for offset, text in sorted(inserts, reverse=True):
            repaired = repaired[:offset] + text + repaired[offset:]
        retried = parse_protected(repaired)
    clean = retried is not root and len(_errors(retried)) <= len(_errors(root))
    return (retried, repaired) if clean else (root, data)


def _errors(root: TSNodeLike) -> set[tuple[int, int]]:
    stack, spans = [root], set()
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type == "ERROR" or node.is_missing:
            spans.add((node.start_byte, node.end_byte))
    return spans


def statement_boundaries(data: bytes) -> bytes:
    """Make newlines swallowed between command words explicit separators.

    tree-sitter-bash can absorb a statement newline into a nested pipeline
    when the following statement has a file redirect, and folds it into
    the next word when a backslash opens that word (``\\ls``, the alias
    bypass), so the next line reads as more arguments. A newline between
    children of a simple command, a redirect or a declaration cannot be
    whitespace in bash: quoted newlines belong to a child, continuations
    have already been joined, and an escaped blank beside it is a word the
    grammar skipped (``_skipped_escapes``). Insert a semicolon without
    removing bytes so source maps remain valid, before a comment that ends
    the statement, since one after it would be read as part of the comment.

    Args:
        data (bytes): source after heredoc lowering and continuation removal.
    """
    if b"\n" not in data:
        return data
    root = TS_PARSER.parse(data).root_node
    offsets: set[int] = set()
    stack = [root]
    while stack:
        node = stack.pop()
        stack.extend(node.children)
        if node.type not in (
            "command",
            "declaration_command",
            "file_redirect",
            "redirected_statement",
            "unset_command",
        ):
            continue
        for left, right in zip(node.children, node.children[1:]):
            folded = data[right.start_byte : right.start_byte + 1] == b"\n"
            gap = data[left.end_byte : right.start_byte + folded]
            if b"\n" in gap and not _ESCAPED_BLANK.sub(b"", gap).strip():
                offsets.add(
                    left.start_byte
                    if left.type == "comment"
                    else left.end_byte + gap.index(b"\n")
                )
    for offset in sorted(offsets, reverse=True):
        data = data[:offset] + b";" + data[offset:]
    return data
