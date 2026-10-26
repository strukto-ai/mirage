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

from functools import partial

from mirage.shell.call_stack import CallStack
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
from mirage.workspace.expand.pattern import expand_pattern, expand_regex
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.expand.variable import ifs_value
from mirage.workspace.node.test_tokens import (
    PATTERN_OPS,
    CondParser,
    CondTree,
    cond_tokens,
    flat_tokens,
)


async def expand_test_expr(
    node: TSNodeLike,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    cs: CallStack | None,
    view: SessionView | None = None,
) -> list[str | PathSpec]:
    """Expand a test_command ``[ ... ]`` into flat argv, tokens in
    source order.

    The parser nests ``-a``/``-o`` chains by its own precedence, so the shape
    is discarded: every operator token and expanded operand is
    re-serialized and the flat bash arity rules take over. Unquoted
    expansions word-split like bash (an empty one drops out of argv).

    Args:
        node (TSNodeLike): the test_command node.
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

    The parser nests the expression by its own precedence (``=~``
    looser than ``||``, ``!`` tighter than ``=~``), so its tokens are
    read again as bash parses them.

    Args:
        node (TSNodeLike): the test_command node opened with ``[[``.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    tree = CondParser(cond_tokens(node)).parse()
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
        operand = await expand_node(
            tree[2], context, execute_fn, cs, view=view
        )
        return CondUnary(op=tree[1], operand=operand)
    if kind == "binary":
        left = await expand_node(tree[2], context, execute_fn, cs, view=view)
        return await _comparison(
            tree[1], left, tree[3], context, execute_fn, cs, view
        )
    return CondWord(
        await expand_node(tree[1], context, execute_fn, cs, view=view)
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
        right_node (TSNodeLike): the right operand's parsed node.
        context (EvaluationContext): the evaluation expanding it.
        execute_fn (ExecuteFn): workspace execute for command substitutions.
        cs (CallStack | None): call stack for positional parameters.
    """
    if op in PATTERN_OPS:
        # The right side of a match is a pattern word; the shared
        # expander renders its quoting into the matcher's dialect per
        # segment (quoted literal, unquoted live), so the evaluator
        # matches unconditionally. A wholly-literal pattern matches
        # exactly itself.
        expand = expand_regex if op == "=~" else expand_pattern
        pattern = await expand(right_node, context, execute_fn, cs, view)
        return CondBinary(left=left_text, op=op, right=pattern)
    right_text = await expand_node(
        right_node, context, execute_fn, cs, view=view
    )
    return CondBinary(left=left_text, op=op, right=right_text)
