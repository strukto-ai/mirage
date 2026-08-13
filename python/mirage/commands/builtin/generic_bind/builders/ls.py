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
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec


async def ls(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("ls: no resource")
    if not paths:
        cwd_virtual = opts.cwd.virtual if isinstance(opts.cwd,
                                                     PathSpec) else opts.cwd
        cwd_rp = (opts.cwd.resource_path
                  if isinstance(opts.cwd, PathSpec) else opts.cwd.strip("/"))
        paths = [
            PathSpec(virtual=cwd_virtual,
                     directory=cwd_virtual,
                     resolved=False,
                     resource_path=cwd_rp)
        ]
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    stat_fn: Callable[..., Awaitable[FileStat]] = partial(ops.stat, accessor)
    if opts.stat_overlay is not None:
        stat_fn = partial(overlaid_stat, stat_fn, opts.stat_overlay)
    return await ls_generic(resolved, list(texts), opts,
                            partial(ops.readdir, accessor), stat_fn)


BUILDER = Builder('ls', ls, None, False, None)
