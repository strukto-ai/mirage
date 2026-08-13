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
from mirage.commands.builtin.generic.stat import stat_generic
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def stat(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("stat: no resource")
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    stat_fn = bound_op(ops.stat, accessor, opts.index)
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    if overlay is not None:
        stat_fn = partial(overlaid_stat,
                          partial(ops.stat, accessor),
                          overlay,
                          index=opts.index)
    return await stat_generic(resolved, list(texts), opts, stat_fn)


BUILDER = Builder('stat', stat, None, False, None)
