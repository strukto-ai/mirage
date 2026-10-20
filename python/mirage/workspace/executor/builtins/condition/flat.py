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

from mirage.types import PathSpec, word_text
from mirage.workspace.executor.builtins.condition.operators import (
    apply_binary,
    apply_unary,
)
from mirage.workspace.executor.builtins.condition.shape import flat_shape
from mirage.workspace.executor.builtins.condition.types import (
    CondContext,
    CondError,
    FlatAnd,
    FlatBinary,
    FlatFail,
    FlatNode,
    FlatNot,
    FlatString,
    FlatUnary,
)
from mirage.workspace.executor.builtins.scope import _scope_path


async def eval_flat(ctx: CondContext, argv: list[str | PathSpec]) -> bool:
    """Evaluate a flat ``test``/``[`` argument list by test's own
    reading of it (``flat_shape``).

    Args:
        ctx (CondContext): evaluation context.
        argv (list[str | PathSpec]): operands, brackets excluded.
    """
    shape = flat_shape(ctx.name, [word_text(a) for a in argv])
    return await _value(ctx, shape, argv)


async def _value(
    ctx: CondContext, node: FlatNode, argv: list[str | PathSpec]
) -> bool:
    """Evaluate one node of a reading.

    Args:
        ctx (CondContext): evaluation context.
        node (FlatNode): the node.
        argv (list[str | PathSpec]): the words it names by place.
    """
    if node is None:
        return False
    if isinstance(node, FlatString):
        return _scope_path(argv[node.at]) != ""
    if isinstance(node, FlatUnary):
        return await apply_unary(ctx, node.op, argv[node.at])
    if isinstance(node, FlatBinary):
        return await apply_binary(
            ctx, argv[node.left], node.op, argv[node.right]
        )
    if isinstance(node, FlatNot):
        return not await _value(ctx, node.inner, argv)
    if isinstance(node, FlatFail):
        raise CondError(node.message)
    # test evaluates both sides of -a and -o as it reads them.
    left = await _value(ctx, node.left, argv)
    right = await _value(ctx, node.right, argv)
    if isinstance(node, FlatAnd):
        return left and right
    return left or right
