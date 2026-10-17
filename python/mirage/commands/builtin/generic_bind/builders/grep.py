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


from mirage.accessor.base import Accessor
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.generic_bind.search import search_reads
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import CommandIO, Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def grep(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    resolved = (
        await ops.resolve_glob(accessor, paths, ctx.index)
        if paths and ops.is_mounted(accessor)
        else []
    )
    read_bytes, read_stream = await search_reads(
        ops, "grep", accessor, resolved, texts, ctx
    )
    readdir, stat = tree_walk(
        bound_op(ops.read_tree, accessor, ctx.index),
        bound_op(ops.readdir, accessor, ctx.index),
        bound_op(ops.stat, accessor, ctx.index),
    )
    return await grep_generic(
        resolved,
        texts,
        ctx,
        readdir=readdir,
        stat=stat,
        read_bytes=read_bytes,
        read_stream=read_stream,
        stdin=ctx.stdin,
    )


BUILDER = GenericCommand("grep", grep, aggregate=prefix_aggregate, read=True)
