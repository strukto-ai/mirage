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

from mirage.context import reset_admission, set_admission
from mirage.rs.errors import RegexError
from mirage.rs.regex import posix_regex
from mirage.shell.array import make_array
from mirage.shell.bytes import byte_view, text_view, utf8_locale
from mirage.shell.errors import ArithError, ReadonlyError
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.executor.builtins.condition.constants import (
    FILE_PAIR_BINARY,
    INT_COMPARATORS,
    UNARY_OPS,
)
from mirage.workspace.executor.builtins.condition.operators import (
    apply_file_pair,
    apply_unary,
)
from mirage.workspace.executor.builtins.condition.types import (
    CondAnd,
    CondBinary,
    CondContext,
    CondError,
    CondLazy,
    CondNode,
    CondNot,
    CondOr,
    CondUnary,
    CondWord,
)
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import (
    random_reader,
    seed_var,
    session_arith,
    visible_env,
)


async def eval_cond(ctx: CondContext, node: CondNode) -> int:
    """Evaluate a structured ``[[ ]]`` expression tree to its status.

    A test answers 0 or 1, and a regex that does not compile answers 2
    without a word. The expression answers what its last test did:
    ``&&`` stops at the first failure, ``||`` at the first success, and
    ``!`` turns any failure into 0.

    Args:
        ctx (CondContext): evaluation context.
        node (CondNode): parsed condition.
    """
    if isinstance(node, CondLazy):
        return await eval_cond(ctx, await node.expand())
    if isinstance(node, CondAnd):
        left = await eval_cond(ctx, node.left)
        return left if left else await eval_cond(ctx, node.right)
    if isinstance(node, CondOr):
        left = await eval_cond(ctx, node.left)
        return 0 if left == 0 else await eval_cond(ctx, node.right)
    if isinstance(node, CondNot):
        return 0 if await eval_cond(ctx, node.inner) else 1
    if ctx.admit is None:
        return await _eval_leaf(ctx, node)
    # A leaf is a test of its own, admitted on its words once they are
    # expanded, which for a branch is only as it is reached.
    token = set_admission(await ctx.admit(_leaf_words(node)))
    try:
        return await _eval_leaf(ctx, node)
    finally:
        reset_admission(token)


def _leaf_words(node: CondUnary | CondBinary | CondWord) -> list[str]:
    """A ``[[ ]]`` leaf as the words ``test`` would be given for it.

    Args:
        node (CondUnary | CondBinary | CondWord): the leaf.
    """
    if isinstance(node, CondUnary):
        return [node.op, node.operand]
    if isinstance(node, CondBinary):
        return [node.left, node.op, node.right]
    return [node.value]


async def _eval_leaf(
    ctx: CondContext, node: CondUnary | CondBinary | CondWord
) -> int:
    """Evaluate one test of a ``[[ ]]`` expression to its status.

    Args:
        ctx (CondContext): evaluation context.
        node (CondUnary | CondBinary | CondWord): the test.
    """
    if isinstance(node, CondUnary):
        if node.op not in UNARY_OPS:
            raise CondError("mirage: conditional unary operator expected")
        return 0 if await apply_unary(ctx, node.op, node.operand) else 1
    if isinstance(node, CondBinary):
        if node.op == "=~":
            return await _regex_status(ctx, node)
        return 0 if await _eval_cond_binary(ctx, node) else 1
    return 0 if node.value != "" else 1


async def _regex_status(ctx: CondContext, node: CondBinary) -> int:
    """Match ``[[ left =~ right ]]``, filling BASH_REMATCH on a match.

    Args:
        ctx (CondContext): evaluation context.
        node (CondBinary): the ``=~`` condition.
    """
    # The shell's own locale, which an unexported LC_ALL sets as well.
    utf8 = utf8_locale(visible_env(ctx.session))
    left = byte_view(node.left, utf8)
    # bash hands the pattern to regcomp(REG_EXTENDED): glibc's
    # POSIX_EXTENDED syntax, where `\d` is a `d` and `(?` is refused.
    try:
        regex = posix_regex(byte_view(node.right, utf8), True, utf8=utf8)
        found = await regex.search(left)
    except RegexError:
        return 2
    if found is None:
        return 1
    seed_var(
        ctx.session,
        "BASH_REMATCH",
        make_array(
            [
                "" if span is None else text_view(left[slice(*span)], utf8)
                for span in found
            ]
        ),
    )
    return 0


async def _eval_cond_binary(ctx: CondContext, node: CondBinary) -> bool:
    """Evaluate a ``[[ ]]`` binary: pattern/string/arith semantics.

    Args:
        ctx (CondContext): evaluation context.
        node (CondBinary): binary condition.
    """
    # == and != always fnmatch: the builder already rendered the right
    # side into the glob dialect, quoted segments escaped, so a
    # wholly-literal pattern matches exactly itself.
    if node.op in ("=", "=="):
        return fnmatch(node.left, node.right, extglob=True)
    if node.op == "!=":
        return not fnmatch(node.left, node.right, extglob=True)
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
        # session view before the next reads, RANDOM's seed included
        # (`[[ RANDOM=42 -eq RANDOM ]]` seeds, then draws).
        reader = random_reader(ctx.session)
        values = []
        for operand in (node.left, node.right):
            error: ArithError | ReadonlyError | None = None
            value = 0
            try:
                result = session_arith(ctx.session, operand, reader)
                writes, value = result.writes, result.value
            except (ArithError, ReadonlyError) as exc:
                # bash bound what the operand assigned before it failed
                # (`y='x=6,1/0'; [[ 0 -eq y ]]` leaves x at 6, and a
                # RANDOM seed in it is drawn from); they land, and the
                # reader settles, before the error reports.
                error, writes = exc, exc.writes
            try:
                for write in writes:
                    status = await assign_element(
                        ctx.session,
                        ctx.view,
                        write.name,
                        write.key,
                        write.value,
                    )
                    if status != "ok":
                        raise CondError(f"{ctx.name}: {write.name}: {status}")
            finally:
                reader.settle()
            if error is not None:
                # bash: `[[: 1/0: division by 0` or `R: readonly variable`,
                # status 1, and the line goes on; in a subscript it ends
                # the shell.
                if error.in_subscript:
                    raise error.signal()
                lead = f"{ctx.name}: " if isinstance(error, ArithError) else ""
                raise CondError(
                    f"bash: {lead}{error}", exit_code=1, fatal=False
                )
            values.append(value)
        return compare(values[0], values[1])
    if node.op in FILE_PAIR_BINARY:
        return await apply_file_pair(ctx, node.op, node.left, node.right)
    raise CondError("mirage: conditional binary operator expected")
