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

from mirage.accessor.gridfs import GridFSAccessor
from mirage.commands.builtin.generic.stat import stat as generic_stat
from mirage.commands.builtin.generic_bind.adapter import (bound_op,
                                                          overlaid_stat)
from mirage.commands.builtin.gridfs.io import resolve_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.core.gridfs.stat import stat as stat_core
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("stat", resource="gridfs", spec=SPECS["stat"])
async def stat(
    accessor: GridFSAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        raise ValueError("stat: missing operand")
    fl = FlagView(opts.flags, spec=SPECS["stat"])
    paths = await resolve_glob(accessor, paths, opts.index)
    stat_fn = bound_op(stat_core, accessor, opts.index)
    if opts.stat_overlay is not None:
        stat_fn = partial(overlaid_stat,
                          partial(stat_core, accessor),
                          opts.stat_overlay,
                          index=opts.index)
    return await generic_stat(paths,
                              stat_fn=stat_fn,
                              c=fl.as_str("c"),
                              f=fl.as_str("f"),
                              L=fl.as_bool("L"),
                              links=opts.links)
