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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.aggregators import prefix_aggregate
from mirage.commands.builtin.generic.grep import facts, grep_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.generic_bind.search import (
    capped_reads,
    matching_tree,
    search_reads,
)
from mirage.commands.builtin.utils.links import mounts_of
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import Context
from mirage.errors.types import WalkDeclinedError
from mirage.io.memory import memory_room
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


logger = logging.getLogger(__name__)


async def grep(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    resolved = await files.resolve_glob(paths) if paths else []
    query_files = True
    try:
        matches = await matching_tree(files, resolved, texts, ctx)
    except WalkDeclinedError as exc:
        logger.debug("grep candidate search declined: %s", exc)
        matches = None
        query_files = False
    if matches is None:
        read = await search_reads(
            files, "grep", resolved, texts, ctx, query_files=query_files
        )
        room = memory_room()
        readdir, stat = tree_walk(
            files.read_tree,
            files.readdir,
            files.stat,
            files.answers("read_tree"),
            subtree_limit=max(1, min(1024, room // 4096))
            if room is not None and room <= 32 * 1024 * 1024
            else None,
        )
    else:

        async def listing(path: PathSpec) -> list[str]:
            return matches.get(path.virtual, [])

        readdir, stat = listing, files.stat
        read, _ = capped_reads(files.read, resolved, mounts_of(ctx))
    return await grep_generic(
        resolved,
        texts,
        ctx,
        readdir=readdir,
        stat=stat,
        read=read,
        stdin=ctx.stdin,
    )


BUILDER = GenericCommand(
    "grep",
    grep,
    aggregate=prefix_aggregate,
    read=True,
    gives_back=True,
    facts=facts,
)
