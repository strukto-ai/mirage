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
from mirage.commands.builtin.generic.find import find_walk_generic
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    CommandFiles,
    command_files,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.tree import tree_walk
from mirage.commands.config import Context
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def find(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    return await find_walk(
        files, await resolve_or_empty(files, paths), texts, ctx
    )


async def find_walk(
    files: CommandFiles,
    resolved: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Walk readdir/stat for find.

    Each start point asks the mount's ``read_tree`` for its subtree
    first, down to the expression's ``-maxdepth``, so the walk costs one
    call where the mount can answer.

    Args:
        files (CommandFiles): the command's files.
        resolved (list[PathSpec]): the glob-resolved start points.
        texts (list[str]): the raw expression words.
        ctx (Context): the invocation's context.
    """
    readdir, stat = tree_walk(
        files.read_tree, files.readdir, files.stat, False
    )
    return await find_walk_generic(
        resolved,
        list(texts),
        ctx,
        readdir=readdir,
        stat=stat,
        unbounded=tree_walk(
            files.read_tree,
            files.readdir,
            files.stat,
            files.answers("read_tree"),
        ),
    )


BUILDER = GenericCommand("find", find)
