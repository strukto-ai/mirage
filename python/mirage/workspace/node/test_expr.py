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
from functools import partial

from mirage.shell.call_stack import CallStack
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.shell.types import TSNodeLike
from mirage.types import PathSpec
from mirage.utils.glob_walk import unmark_globs
from mirage.view.types import SessionView
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.condition.types import (
    CondAnd,
    CondBinary,
    CondLazy,
    CondNode,
    CondNot,
    CondOr,
    CondUnary,
    CondWord,
)
from mirage.workspace.expand import expand_node
from mirage.workspace.expand.fields import split_fields
from mirage.workspace.expand.node import expand_chunks
from mirage.workspace.expand.pattern import expand_pattern
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.expand.variable import ifs_value
from mirage.workspace.node.test_tokens import (
    CondParser,
    CondSyntax,
    CondTree,
    ExprToken,
    cond_tokens,
    flat_tokens,
)

logger = logging.getLogger(__name__)

_COND_OP_TOKENS = frozenset({"=", "==", "!=", "=~", "<", ">", "&&", "||"})


async def expand_test_expr(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> list[str | PathSpec]:
    """Expand a test_command ``[ ... ]`` into flat argv, tokens in
    source order.

    tree-sitter nests ``-a``/``-o`` chains unpredictably, so the shape
    is discarded: every operator token and expanded operand is
    re-serialized and the flat bash arity rules take over. Unquoted
    expansions word-split like bash (an empty one drops out of argv).

    Args:
        node (TSNodeLike): tree-sitter test_command node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    session = context.session
    result: list[str | PathSpec] = []
    for token in flat_tokens(node):
        if token.op is not None:
            result.append(token.op)
        elif token.negative:
            expanded = await expand_node(
                token.operand, context, execute_fn, cs, view=view
            )
            result.append("-" + expanded)
        else:
            chunks = await expand_chunks(
                token.operand, context, execute_fn, cs, view=view
            )
            result.extend(
                unmark_globs(word)
                for word in split_fields(chunks, ifs_value(session, cs))
            )
    return result


async def expand_double_bracket(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> CondNode:
    """Build a structured condition tree from a ``[[ ... ]]`` node.

    tree-sitter nests the expression by its own precedence (``=~``
    looser than ``||``, ``!`` tighter than ``=~``), so its tokens are
    read again as bash parses them; a shape that reading refuses keeps
    tree-sitter's tree.

    Args:
        node (TSNodeLike): tree-sitter test_command node opened with ``[[``.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    exprs = [c for c in node.named_children]
    if not exprs:
        return CondWord("")
    try:
        tree = CondParser(cond_tokens(node)).parse()
    except CondSyntax as exc:
        logger.debug("[[ ]] keeps tree-sitter's reading: %s", exc)
        return await _build_cond(exprs[0], context, execute_fn, cs, view=view)
    return await _cond_node(tree, context, execute_fn, cs, view)


async def _cond_node(
    tree: CondTree,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None,
) -> CondNode:
    """Expand one parsed ``[[ ]]`` tree into a CondNode.

    Args:
        tree (CondTree): from ``CondParser``.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    kind = tree[0]
    if kind in ("and", "or"):
        # Expansion is part of evaluating an operand, so skipped branches
        # cannot run substitutions or observe state before the left side.
        first = CondLazy(
            partial(_cond_node, tree[1], context, execute_fn, cs, view)
        )
        second = CondLazy(
            partial(_cond_node, tree[2], context, execute_fn, cs, view)
        )
        if kind == "and":
            return CondAnd(first, second)
        return CondOr(first, second)
    if kind == "not":
        return CondNot(
            await _cond_node(tree[1], context, execute_fn, cs, view)
        )
    if kind == "group":
        return await _cond_node(tree[1], context, execute_fn, cs, view)
    if kind == "unary":
        operand = await _token_text(tree[2], context, execute_fn, cs, view)
        return CondUnary(op=tree[1], operand=operand)
    if kind == "binary":
        left_text = await _token_text(tree[2], context, execute_fn, cs, view)
        right: ExprToken = tree[3]
        if right.negative:
            right_text = await _token_text(
                right, context, execute_fn, cs, view
            )
            return CondBinary(left=left_text, op=tree[1], right=right_text)
        return await _comparison(
            tree[1], left_text, right.operand, context, execute_fn, cs, view
        )
    return CondWord(await _token_text(tree[1], context, execute_fn, cs, view))


async def _token_text(
    token: ExprToken,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None,
) -> str:
    text = await expand_node(token.operand, context, execute_fn, cs, view=view)
    return "-" + text if token.negative else text


async def _build_cond(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> CondNode:
    """Recursively translate one expression node into a CondNode.

    Args:
        node (TSNodeLike): tree-sitter expression node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    ntype = node.type
    if ntype == NT.PARENTHESIZED_EXPRESSION:
        inner = [c for c in node.named_children]
        if not inner:
            return CondWord("")
        return await _build_cond(inner[0], context, execute_fn, cs, view=view)
    if ntype in (NT.UNARY_EXPRESSION, NT.NEGATION_EXPRESSION):
        return await _build_unary(node, context, execute_fn, cs, view=view)
    if ntype == NT.BINARY_EXPRESSION:
        return await _build_binary(node, context, execute_fn, cs, view=view)
    value = await expand_node(node, context, execute_fn, cs, view=view)
    return CondWord(value)


async def _build_unary(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> CondNode:
    """Translate a unary/negation expression node.

    Args:
        node (TSNodeLike): tree-sitter unary_expression or negation_expression.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    negated = any(c.type == "!" for c in node.children)
    op = None
    operand_node = None
    for child in node.children:
        if child.type == NT.TEST_OPERATOR:
            op = get_text(child)
        elif child.is_named:
            operand_node = child
    if op is None and operand_node is not None and negated:
        inner = await _build_cond(
            operand_node, context, execute_fn, cs, view=view
        )
        return CondNot(inner)
    if op is None:
        value = ""
        if operand_node is not None:
            value = await expand_node(
                operand_node, context, execute_fn, cs, view=view
            )
        result: CondNode = CondWord(value)
        return CondNot(result) if negated else result
    operand = ""
    if operand_node is not None:
        operand = await expand_node(
            operand_node, context, execute_fn, cs, view=view
        )
    unary: CondNode = CondUnary(op=op, operand=operand)
    return CondNot(unary) if negated else unary


async def _build_binary(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> CondNode:
    """Translate a binary expression node (logical or comparison).

    Args:
        node (TSNodeLike): tree-sitter binary_expression.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    op = None
    operands: list[TSNodeLike] = []
    for child in node.children:
        if not child.is_named:
            if child.type in _COND_OP_TOKENS:
                op = child.type
            continue
        if child.type == NT.TEST_OPERATOR and op is None and operands:
            op = get_text(child)
            continue
        operands.append(child)
    if op in ("&&", "||") and len(operands) == 2:
        # Expansion is part of evaluating an operand, so skipped branches
        # cannot run substitutions or observe state before the left side.
        left = CondLazy(
            partial(
                _build_cond, operands[0], context, execute_fn, cs, view=view
            )
        )
        right = CondLazy(
            partial(
                _build_cond, operands[1], context, execute_fn, cs, view=view
            )
        )
        return CondAnd(left, right) if op == "&&" else CondOr(left, right)
    if op is None or len(operands) != 2:
        text_parts = []
        for operand in operands:
            text_parts.append(
                await expand_node(operand, context, execute_fn, cs, view=view)
            )
        return CondWord(" ".join(text_parts))
    left_text = await expand_node(
        operands[0], context, execute_fn, cs, view=view
    )
    return await _comparison(
        op, left_text, operands[1], context, execute_fn, cs, view
    )


async def _comparison(
    op: str,
    left_text: str,
    right_node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None,
) -> CondNode:
    """A binary test, its right operand expanded as ``op`` reads it.

    Args:
        op (str): the operator.
        left_text (str): the expanded left operand.
        right_node (TSNodeLike): the right operand's tree-sitter node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    if op == "=~" and right_node.type == NT.REGEX:
        raw = get_text(right_node)
        # After =~ tree-sitter lexes even a quoted operand as one regex
        # token; quoted means bash matches it literally.
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
            return CondBinary(
                left=left_text, op=op, right=raw[1:-1], right_literal=True
            )
        return CondBinary(
            left=left_text, op=op, right=raw, right_literal=False
        )
    if op in ("=", "==", "!="):
        # The right side of a glob comparison is a pattern word; the
        # shared expander renders its quoting into the matcher's
        # dialect per segment (quoted literal, unquoted globs live), so
        # the evaluator fnmatches unconditionally. A wholly-literal
        # pattern matches exactly itself, which is what the equality
        # the old whole-node boolean spelled out reduced to.
        pattern = await expand_pattern(
            right_node, context, execute_fn, cs, view=view
        )
        return CondBinary(
            left=left_text, op=op, right=pattern, right_literal=False
        )
    right_text = await expand_node(
        right_node, context, execute_fn, cs, view=view
    )
    return CondBinary(
        left=left_text, op=op, right=right_text, right_literal=False
    )
