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

from collections.abc import Awaitable, Callable
from functools import partial

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic.ls import ls_generic
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    bound_op,
    overlaid_stat,
)
from mirage.commands.builtin.utils.tree import WalkCall, tree_walk
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec


async def ls(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("ls: no VFS")
    if not paths:
        paths = [
            PathSpec(
                virtual=opts.cwd.virtual,
                directory=opts.cwd.virtual,
                resolved=False,
                vfs_path=opts.cwd.vfs_path,
            )
        ]
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    readdir: WalkCall = partial(ops.readdir, accessor)
    stat: WalkCall = partial(ops.stat, accessor)
    # Only -R walks; a plain listing reads one directory.
    if FlagView(opts.flags, spec=SPECS["ls"]).as_bool("recursive"):
        readdir, stat = tree_walk(
            bound_op(ops.read_tree, accessor, opts.index), readdir, stat
        )
    stat_fn: Callable[..., Awaitable[FileStat]] = stat
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    if overlay is not None:
        stat_fn = partial(overlaid_stat, stat_fn, overlay)
    return await ls_generic(resolved, list(texts), opts, readdir, stat_fn)


BUILDER = GenericCommand("ls", ls)
