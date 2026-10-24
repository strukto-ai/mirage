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
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.generic_bind.search import search_reads
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def grep(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await files.resolve_glob(paths) if paths else []
    read = await search_reads(files, "grep", resolved, texts, ctx)
    readdir, stat = tree_walk(
        (files.read_tree if files.answers("read_tree") else None),
        files.readdir,
        files.stat,
    )
    return await grep_generic(
        resolved,
        texts,
        ctx,
        readdir=readdir,
        stat=stat,
        read=read,
        stdin=ctx.stdin,
    )


BUILDER = GenericCommand("grep", grep, aggregate=prefix_aggregate, read=True)
