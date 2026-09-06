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
from mirage.workspace.executor.builtins.condition.operators import (
    apply_file_pair, apply_unary)
from mirage.workspace.session import visible_env
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (random_reader, seed_var,
                                            session_elements)

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
        seed_var(ctx.session, "BASH_REMATCH",
                 make_array([match.group(0), *groups]))
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
        # bash evaluates the left operand, binds what it assigned, then
        # evaluates the right (`[[ x=5 -eq x ]]` is true and leaves x at
        # 5), so each operand lands its assignments through the gated
        # door before the next reads, RANDOM's seed included
        # (`[[ RANDOM=42 -eq RANDOM ]]` seeds, then draws).
        reader = random_reader(ctx.session)
        values = []
        for operand in (node.left, node.right):
            error: ArithError | None = None
            value = 0
            try:
                result = evaluate_arith(operand,
                                        visible_env(ctx.session),
                                        elements=session_elements(
                                            ctx.session, reader),
                                        read_var=reader.read,
                                        wrote_var=reader.wrote)
                writes, value = result.writes, result.value
            except ArithError as exc:
                # bash bound what the operand assigned before it failed
                # (`y='x=6,1/0'; [[ 0 -eq y ]]` leaves x at 6, and a
                # RANDOM seed in it is drawn from); they land, and the
                # reader settles, before the error reports.
                error, writes = exc, exc.writes
            for write in writes:
                status = await assign_element(ctx.session, ctx.view,
                                              write.name, write.key,
                                              write.value)
                if status != "ok":
                    raise CondError(f"{ctx.name}: {write.name}: {status}")
            reader.settle()
            if error is not None:
                # bash: `[[: 1/0: division by 0`, status 1, and the line
                # goes on; only a grammar error is fatal.
                raise CondError(f"bash: {ctx.name}: {operand}: {error}",
                                exit_code=1,
                                fatal=False)
            values.append(value)
        return compare(values[0], values[1])
    if node.op in FILE_PAIR_BINARY:
        return await apply_file_pair(ctx, node.op, node.left, node.right)
    raise CondError("mirage: conditional binary operator expected")
