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

from mirage.shell.arith import ArithError, evaluate_arith
from mirage.shell.array import make_array
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.executor.builtins.condition.constants import (
    FILE_PAIR_BINARY, INT_COMPARATORS, UNARY_OPS)
from mirage.workspace.executor.builtins.condition.operators import apply_unary
from mirage.workspace.session import visible_env

from mirage.workspace.executor.builtins.condition.types import (  # isort: skip
    CondAnd, CondBinary, CondContext, CondError, CondNode, CondNot, CondOr,
    CondUnary)


async def eval_cond(ctx: CondContext, node: CondNode) -> bool:
    """Evaluate a structured ``[[ ]]`` expression tree.

    Args:
        ctx (CondContext): evaluation context.
        node (CondNode): parsed condition.
    """
    if isinstance(node, CondAnd):
        return (await eval_cond(ctx, node.left)
                and await eval_cond(ctx, node.right))
    if isinstance(node, CondOr):
        return (await eval_cond(ctx, node.left)
                or await eval_cond(ctx, node.right))
    if isinstance(node, CondNot):
        return not await eval_cond(ctx, node.inner)
    if isinstance(node, CondUnary):
        if node.op not in UNARY_OPS:
            raise CondError("mirage: conditional unary operator expected")
        return await apply_unary(ctx, node.op, node.operand)
    if isinstance(node, CondBinary):
        return await _eval_cond_binary(ctx, node)
    return node.value != ""


async def _eval_cond_binary(ctx: CondContext, node: CondBinary) -> bool:
    """Evaluate a ``[[ ]]`` binary: pattern/regex/string/arith semantics.

    Args:
        ctx (CondContext): evaluation context.
        node (CondBinary): binary condition.
    """
    # == and != always fnmatch: the builder already rendered the right
    # side into the glob dialect, quoted segments escaped, so a
    # wholly-literal pattern matches exactly itself.
    if node.op in ("=", "=="):
        return fnmatch(node.left, node.right)
    if node.op == "!=":
        return not fnmatch(node.left, node.right)
    if node.op == "=~":
        pattern = re.escape(node.right) if node.right_literal else node.right
        try:
            match = re.search(pattern, node.left)
        except re.error:
            raise CondError("mirage: syntax error in conditional expression")
        if match is None:
            return False
        groups = [g if g is not None else "" for g in match.groups()]
        ctx.session.arrays["BASH_REMATCH"] = make_array(
            [match.group(0), *groups])
        return True
    if node.op == "<":
        return node.left < node.right
    if node.op == ">":
        return node.left > node.right
    compare = INT_COMPARATORS.get(node.op)
    if compare is not None:
        # [[ evaluates numeric operands as arithmetic: variables
        # resolve, expressions compute, bare unset words are 0. The
        # visible env, so a hidden name reads as unset here too.
        try:
            li, _ = evaluate_arith(node.left, visible_env(ctx.session))
            ri, _ = evaluate_arith(node.right, visible_env(ctx.session))
        except ArithError:
            raise CondError("mirage: syntax error in conditional expression")
        return compare(li, ri)
    if node.op in FILE_PAIR_BINARY:
        raise CondError(f"{ctx.name}: {node.op}: unsupported operator")
    raise CondError("mirage: conditional binary operator expected")
