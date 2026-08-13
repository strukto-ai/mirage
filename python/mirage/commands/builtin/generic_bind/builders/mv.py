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
from mirage.commands.builtin.generic.mv import mv as generic_mv
from mirage.commands.builtin.generic.mv import parse_mv_flags
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation, bound_op)
from mirage.commands.builtin.generic_bind.builders.cp import overlayable_stat
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import NativeMove, PathSpec


async def mv(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("mv: no resource")
    fl = FlagView(opts.flags, spec=SPECS["mv"])
    parsed = parse_mv_flags(fl)
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    return await generic_mv(
        paths,
        strategy=NativeMove(
            rename=partial(ops.require(Operation.RENAME), accessor)),
        stat=overlayable_stat(ops, accessor, opts.index, overlay),
        flags=parsed,
        readdir=bound_op(ops.readdir, accessor, opts.index))


BUILDER = Builder('mv',
                  mv,
                  write=True,
                  requirements=frozenset({Operation.RENAME}))
