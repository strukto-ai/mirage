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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.tree import tree_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def tree(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("tree: no VFS")
    resolved = await ops.resolve_glob(accessor, paths, ctx.index)
    readdir = partial(ops.readdir, accessor)
    stat = partial(ops.stat, accessor)
    return await tree_generic(
        resolved,
        list(texts),
        ctx,
        readdir,
        stat,
        unbounded=tree_walk(
            bound_op(ops.read_tree, accessor, ctx.index), readdir, stat
        ),
    )


BUILDER = GenericCommand("tree", tree)
