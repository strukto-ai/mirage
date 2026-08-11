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

from typing import Any

from mirage.shell.types import NodeType as NT
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.condition import (CondAnd, CondBinary,
                                                          CondNode, CondNot,
                                                          CondOr, CondUnary,
                                                          CondWord)
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.pattern import expand_pattern

_CONTAINER_TYPES = (NT.BINARY_EXPRESSION, NT.UNARY_EXPRESSION,
                    NT.NEGATION_EXPRESSION, NT.PARENTHESIZED_EXPRESSION)
_FLAT_OP_TOKENS = frozenset({"=", "==", "!=", "<", ">", "!", "(", ")"})
_COND_OP_TOKENS = frozenset({"=", "==", "!=", "=~", "<", ">", "&&", "||"})
_SPLIT_TYPES = (NT.SIMPLE_EXPANSION, NT.EXPANSION)


async def expand_test_expr(node, session, execute_fn,
                           cs) -> list[str | PathSpec]:
    """Expand a test_command ``[ ... ]`` into flat argv, tokens in
    source order.

    tree-sitter nests ``-a``/``-o`` chains unpredictably, so the shape
    is discarded: every operator token and expanded operand is
    re-serialized and the flat bash arity rules take over. Unquoted
    expansions word-split like bash (an empty one drops out of argv).

    Args:
        node: tree-sitter test_command node.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    result: list[str | PathSpec] = []
    await _flatten(node, result, session, execute_fn, cs)
    return result


async def _flatten(node, out: list[str | PathSpec], session, execute_fn,
                   cs) -> bool:
    """Append the flat tokens of one test-expression node to ``out``.

    Returns False when a statement separator surfaced inside an ERROR
    recovery node — tree-sitter swallowed the rest of the line into the
    test, so everything after the break point is discarded.

    Args:
        node: tree-sitter node to serialize.
        out (list[str]): accumulator.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    for child in node.children:
        ctype = child.type
        if ctype in ("[", "]", "[[", "]]"):
            continue
        if ctype == NT.ERROR:
            if any(not g.is_named and g.type == ";" for g in child.children):
                return False
            if not await _flatten(child, out, session, execute_fn, cs):
                return False
            continue
        if not child.is_named:
            if ctype in _FLAT_OP_TOKENS:
                out.append(child.text.decode())
            continue
        if ctype in _CONTAINER_TYPES:
            negative = _negative_number_child(child)
            if negative is not None:
                expanded = await expand_node(negative, session, execute_fn, cs)
                out.append("-" + expanded)
                continue
            if not await _flatten(child, out, session, execute_fn, cs):
                return False
            continue
        if ctype == NT.TEST_OPERATOR:
            out.append(child.text.decode())
            continue
        expanded = await expand_node(child, session, execute_fn, cs)
        if ctype in _SPLIT_TYPES:
            out.extend(expanded.split())
            continue
        out.append(expanded)
    return True


def _negative_number_child(node):
    """Detect a unary_expression that is really a negative number word.

    tree-sitter parses ``-1`` inside a test as unary_expression with a
    bare ``-`` token; the flat argv needs it back as one operand.

    Args:
        node: tree-sitter container node.
    """
    if node.type != NT.UNARY_EXPRESSION:
        return None
    children = list(node.children)
    if (len(children) == 2 and not children[0].is_named
            and children[0].type == "-" and children[1].is_named
            and children[1].type != NT.TEST_OPERATOR):
        return children[1]
    return None


async def expand_double_bracket(node, session, execute_fn, cs) -> CondNode:
    """Build a structured condition tree from a ``[[ ... ]]`` node.

    Args:
        node: tree-sitter test_command node opened with ``[[``.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    exprs = [c for c in node.named_children]
    if not exprs:
        return CondWord("")
    return await _build_cond(exprs[0], session, execute_fn, cs)


async def _build_cond(node, session, execute_fn, cs) -> CondNode:
    """Recursively translate one expression node into a CondNode.

    Args:
        node: tree-sitter expression node.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    ntype = node.type
    if ntype == NT.PARENTHESIZED_EXPRESSION:
        inner = [c for c in node.named_children]
        if not inner:
            return CondWord("")
        return await _build_cond(inner[0], session, execute_fn, cs)
    if ntype in (NT.UNARY_EXPRESSION, NT.NEGATION_EXPRESSION):
        return await _build_unary(node, session, execute_fn, cs)
    if ntype == NT.BINARY_EXPRESSION:
        return await _build_binary(node, session, execute_fn, cs)
    value = await expand_node(node, session, execute_fn, cs)
    return CondWord(value)


async def _build_unary(node, session, execute_fn, cs) -> CondNode:
    """Translate a unary/negation expression node.

    Args:
        node: tree-sitter unary_expression or negation_expression.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    negated = any(c.type == "!" for c in node.children)
    op = None
    operand_node = None
    for child in node.children:
        if child.type == NT.TEST_OPERATOR:
            op = child.text.decode()
        elif child.is_named:
            operand_node = child
    if op is None and operand_node is not None and negated:
        inner = await _build_cond(operand_node, session, execute_fn, cs)
        return CondNot(inner)
    if op is None:
        value = ""
        if operand_node is not None:
            value = await expand_node(operand_node, session, execute_fn, cs)
        result: CondNode = CondWord(value)
        return CondNot(result) if negated else result
    operand = ""
    if operand_node is not None:
        operand = await expand_node(operand_node, session, execute_fn, cs)
    unary: CondNode = CondUnary(op=op, operand=operand)
    return CondNot(unary) if negated else unary


async def _build_binary(node, session, execute_fn, cs) -> CondNode:
    """Translate a binary expression node (logical or comparison).

    Args:
        node: tree-sitter binary_expression.
        session: shell session for expansion.
        execute_fn: workspace execute for command substitutions.
        cs: call stack for positional parameters.
    """
    op = None
    operands: list[Any] = []
    for child in node.children:
        if not child.is_named:
            if child.type in _COND_OP_TOKENS:
                op = child.type
            continue
        if child.type == NT.TEST_OPERATOR and op is None and operands:
            op = child.text.decode()
            continue
        operands.append(child)
    if op in ("&&", "||") and len(operands) == 2:
        left = await _build_cond(operands[0], session, execute_fn, cs)
        right = await _build_cond(operands[1], session, execute_fn, cs)
        return CondAnd(left, right) if op == "&&" else CondOr(left, right)
    if op is None or len(operands) != 2:
        text_parts = []
        for operand in operands:
            text_parts.append(await expand_node(operand, session, execute_fn,
                                                cs))
        return CondWord(" ".join(text_parts))
    left_text = await expand_node(operands[0], session, execute_fn, cs)
    right_node = operands[1]
    if op == "=~" and right_node.type == NT.REGEX:
        raw = right_node.text.decode()
        # After =~ tree-sitter lexes even a quoted operand as one regex
        # token; quoted means bash matches it literally.
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            return CondBinary(left=left_text,
                              op=op,
                              right=raw[1:-1],
                              right_literal=True)
        return CondBinary(left=left_text,
                          op=op,
                          right=raw,
                          right_literal=False)
    if op in ("=", "==", "!="):
        # The right side of a glob comparison is a pattern word; the
        # shared expander renders its quoting into the matcher's
        # dialect per segment (quoted literal, unquoted globs live), so
        # the evaluator fnmatches unconditionally. A wholly-literal
        # pattern matches exactly itself, which is what the equality
        # the old whole-node boolean spelled out reduced to.
        pattern = await expand_pattern(right_node, session, execute_fn, cs)
        return CondBinary(left=left_text,
                          op=op,
                          right=pattern,
                          right_literal=False)
    right_text = await expand_node(right_node, session, execute_fn, cs)
    return CondBinary(left=left_text,
                      op=op,
                      right=right_text,
                      right_literal=False)
