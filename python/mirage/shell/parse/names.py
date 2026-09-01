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
from collections.abc import Iterator

import tree_sitter

from mirage.shell.parse.constants import (ARITH_OPEN_TOKEN,
                                          ARITH_TEST_OPERATORS,
                                          DECLARING_NODES, TARGET_NAME_FIELDS)

_IDENTIFIER_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _collect_names(node: tree_sitter.Node, out: set[str]) -> None:
    if node.type == "function_definition":
        return
    if node.type == "variable_name":
        text = node.text
        if text:
            out.add(text.decode())
        return
    if node.type in DECLARING_NODES:
        for child in node.children:
            if child.type != "variable_name":
                _collect_names(child, out)
        return
    field = TARGET_NAME_FIELDS.get(node.type)
    target = node.child_by_field_name(field) if field else None
    # `+=` reads the target before writing it (`TOKEN+=x` starts from
    # the existing value), so an append's name is a read here too.
    if target is not None and any(c.type == "+=" for c in node.children):
        target = None
    for child in node.children:
        if target is not None and child.id == target.id:
            continue
        _collect_names(child, out)


def walk_named_outside_defs(
        node: tree_sitter.Node) -> Iterator[tree_sitter.Node]:
    """Named nodes, skipping function_definition subtrees.

    A definition's body runs at invocation, not where it is defined,
    so a read walk that descended into one would charge the defining
    line for reads it never performs. The fill layer joins invoked
    bodies back in through its own node set (``line_nodes``).

    Args:
        node (tree_sitter.Node): subtree root.
    """
    if node.type == "function_definition":
        return
    yield node
    for child in node.named_children:
        yield from walk_named_outside_defs(child)


def referenced_names(node: tree_sitter.Node) -> frozenset[str]:
    """Every variable name a parsed program may read when it runs.

    A textual over-approximation over the whole tree, which is safe by
    construction: the worst a spurious name costs is one fetch. Walked
    everywhere -- command substitution bodies, redirect targets,
    heredoc bodies, arithmetic -- with two exceptions that are writes,
    not reads (an assignment's own name, unless it appends, since
    ``+=`` starts from the value it extends; a for loop's variable),
    one that runs later rather than now (a function definition's body,
    which the fill layer joins back in at invocation), and one the
    grammar gives for free: a single-quoted string tokenizes as
    `raw_string` with no children, so `'$X'` never reads X.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    _collect_names(node, out)
    return frozenset(out)


def command_words(node: tree_sitter.Node) -> frozenset[str]:
    """The first word of every command a parsed program runs.

    What the whole-env scan and the CLI env-name lookup key on.
    `command_name` covers ordinary commands wherever they sit; the
    declaring builtins (`export`, `declare`, `local`, `readonly`,
    `unset`) parse as their own node types whose head word is the
    first anonymous token, so those are read directly. A function
    definition's body is skipped: those commands run at invocation,
    where the fill layer walks the stored body instead.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in walk_named_outside_defs(node):
        if n.type == "command_name":
            text = n.text
            if text:
                out.add(text.decode())
        elif n.type in DECLARING_NODES and n.children:
            text = n.children[0].text
            if text:
                out.add(text.decode())
    return frozenset(out)


def literal_text(node: tree_sitter.Node) -> str | None:
    """The argument's text when the parser fixed it, else None.

    A plain word, a number, a raw string and a double-quoted string of
    plain content each spell one literal; anything carrying an
    expansion or a substitution is dynamic and reads as None.

    Args:
        node (tree_sitter.Node): an argument node of a command.
    """
    if node.type in ("word", "number"):
        text = node.text
        return text.decode() if text else None
    if node.type == "raw_string":
        text = node.text
        return text.decode()[1:-1] if text else None
    if node.type == "string":
        named = node.named_children
        if not named:
            return ""
        if len(named) == 1 and named[0].type == "string_content":
            text = named[0].text
            return text.decode() if text else ""
    return None


def command_args(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """A command node's argument children: no name, prefixes, redirects.

    Args:
        node (tree_sitter.Node): a ``command`` node.
    """
    name_node = node.child_by_field_name("name")
    return [
        child for child in node.named_children
        if (name_node is None or child.id != name_node.id) and child.type !=
        "variable_assignment" and not child.type.endswith("_redirect")
    ]


def command_invocations(
    node: tree_sitter.Node
) -> tuple[tuple[str | None, tuple[str | None, ...]], ...]:
    """Every plain command's head word with its argument words.

    Head and arguments are reported as their literal text, or None for
    a word no static read can spell (an expansion, a substitution), so
    a caller matching names (the CLI env-name pruning) can tell "this
    word is not there" from "this word is unknowable". A None head is
    the stronger fact: the command that runs is not decidable before
    expansion, so the fill pass treats the line as an opaque read.
    Assignment prefixes and redirects are not arguments.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: list[tuple[str | None, tuple[str | None, ...]]] = []
    for n in walk_named_outside_defs(node):
        if n.type != "command":
            continue
        name_node = n.child_by_field_name("name")
        if name_node is None:
            continue
        inner = name_node.named_children
        head = literal_text(inner[0]) if len(inner) == 1 else None
        args = tuple(literal_text(child) for child in command_args(n))
        out.append((head, args))
    return tuple(out)


def identifier_names(text: str) -> frozenset[str]:
    """Identifier-shaped tokens in an arithmetic expression string.

    Bash evaluates a variable's value as an expression of its own
    (``x="TOKEN + 1"; $((x))`` reads TOKEN), so a caller chasing that
    recursion needs the names a value may resolve. Over-approximates on
    purpose: ``0x1f`` yields ``x1f``, which reads nothing real and
    costs nothing.

    Args:
        text (str): an expression or value string.
    """
    return frozenset(_IDENTIFIER_RE.findall(text))


def _arith_region_names(region: tree_sitter.Node, out: set[str]) -> None:
    """Names read inside one arithmetic region.

    The grammar is inconsistent about identifiers here: ``$((name))``
    holds a ``variable_name`` while a c-style for's ``i<n`` holds bare
    ``word`` nodes, and a subscript's index is one ``word`` whose text
    is a whole expression -- so words tokenize through
    ``identifier_names`` rather than reading as one name.

    Args:
        region (tree_sitter.Node): the region's root node.
        out (set[str]): collects the names.
    """
    for n in walk_named_outside_defs(region):
        if n.type == "variable_name":
            text = n.text
            if text:
                out.add(text.decode())
        elif n.type == "word":
            text = n.text
            if text:
                out.update(identifier_names(text.decode()))


def _substring_arith_names(expansion: tree_sitter.Node, out: set[str]) -> None:
    """Names in a ``${v:offset:length}`` expansion's arithmetic part.

    The substring form is told apart from ``${v:-d}`` and friends by
    its bare ``:`` token; everything after the first one is offset or
    length, both evaluated as arithmetic.

    Args:
        expansion (tree_sitter.Node): an ``expansion`` node.
        out (set[str]): collects the names.
    """
    seen_colon = False
    for child in expansion.children:
        if not seen_colon:
            seen_colon = not child.is_named and child.type == ":"
            continue
        if child.is_named:
            _arith_region_names(child, out)


def _test_arith_names(test: tree_sitter.Node, out: set[str]) -> None:
    """Names the numeric comparators of one ``[[`` read as arithmetic.

    Args:
        test (tree_sitter.Node): a ``test_command`` node.
        out (set[str]): collects the names.
    """
    for n in walk_named_outside_defs(test):
        if n.type != "binary_expression":
            continue
        operator = next(
            (child
             for child in n.named_children if child.type == "test_operator"),
            None)
        if operator is None:
            continue
        text = operator.text
        if not text or text.decode() not in ARITH_TEST_OPERATORS:
            continue
        for child in n.named_children:
            if child.id != operator.id:
                _arith_region_names(child, out)


def arith_reads(node: tree_sitter.Node) -> frozenset[str]:
    """Names the program reads in an arithmetic context.

    Arithmetic resolution recurses through values (``name=TOKEN;
    $((name))`` reads TOKEN), so these names are the ones whose stored
    values a fill plan must chase. The contexts mirror where the
    executor calls ``evaluate_arith``: ``$((...))`` and ``$[...]``
    expansions, the ``((...))`` command, a c-style for's header, a
    subscript's index, a ``${v:offset:length}`` offset, the ``[[``
    numeric comparators, and ``let``'s operands. ``test``/``[`` are
    absent on purpose: the flat builtin parses integers strictly, so a
    bare word there never resolves as a variable.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in walk_named_outside_defs(node):
        if n.type in ("arithmetic_expansion", "subscript"):
            _arith_region_names(n, out)
        elif (n.type == "compound_statement" and n.children
              and n.children[0].type == ARITH_OPEN_TOKEN):
            _arith_region_names(n, out)
        elif n.type == "c_style_for_statement":
            for child in n.named_children:
                if child.type != "do_group":
                    _arith_region_names(child, out)
        elif n.type == "expansion":
            _substring_arith_names(n, out)
        elif n.type == "test_command":
            _test_arith_names(n, out)
        elif n.type == "command":
            name_node = n.child_by_field_name("name")
            head = name_node.text if name_node is not None else None
            if head == b"let":
                for arg in command_args(n):
                    _arith_region_names(arg, out)
                    literal = literal_text(arg)
                    if literal is not None:
                        out.update(identifier_names(literal))
    return frozenset(out)


def assignment_values(
    node: tree_sitter.Node
) -> tuple[tuple[str, str | None, frozenset[str]], ...]:
    """Every plain assignment's target with what its value may hold.

    Per assignment: the target name, the value's literal text (None
    when no static read can spell it, empty for a bare ``X=``), and,
    for a dynamic value, the names it reads -- an arithmetic read of
    the target may recurse into whichever of those values lands
    (``n=$other; $((n))`` reads what ``other`` holds). Subscripted
    targets are skipped: an element write never replaces the whole
    value.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: list[tuple[str, str | None, frozenset[str]]] = []
    for n in walk_named_outside_defs(node):
        if n.type != "variable_assignment":
            continue
        name_node = n.child_by_field_name("name")
        if name_node is None or name_node.type != "variable_name":
            continue
        text = name_node.text
        if not text:
            continue
        value_node = n.child_by_field_name("value")
        literal = "" if value_node is None else literal_text(value_node)
        reads = referenced_names(n) if literal is None else frozenset()
        out.append((text.decode(), literal, reads))
    return tuple(out)
