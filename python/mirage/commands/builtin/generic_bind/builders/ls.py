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
from mirage.commands.builtin.generic.ls import ls_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
)
from mirage.commands.builtin.utils.tree import WalkCall, tree_walk
from mirage.commands.config import CommandIO, Context
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def ls(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("ls: no VFS")
    if not paths:
        paths = [
            PathSpec(
                virtual=ctx.cwd.virtual,
                directory=ctx.cwd.virtual,
                resolved=False,
                vfs_path=ctx.cwd.vfs_path,
            )
        ]
    resolved = await ops.resolve_glob(accessor, paths, ctx.index)
    readdir: WalkCall = partial(ops.readdir, accessor)
    stat: WalkCall = partial(ops.stat, accessor)
    # Only -R walks; a plain listing reads one directory.
    if FlagView(ctx.flags, spec=SPECS["ls"]).as_bool("recursive"):
        readdir, stat = tree_walk(
            bound_op(ops.read_tree, accessor, ctx.index), readdir, stat
        )
    return await ls_generic(resolved, list(texts), ctx, readdir, stat)


BUILDER = GenericCommand("ls", ls)
