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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.cp import cp as generic_cp
from mirage.commands.builtin.generic.cp import parse_cp_flags
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          Operation,
                                                          OperationFn,
                                                          bound_op,
                                                          overlaid_stat)
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import StatOverlay
from mirage.types import NativeCopy, PathSpec
from mirage.utils.key_prefix import rekey


async def _walk_find(readdir: OperationFn,
                     stat: OperationFn,
                     index: IndexCacheStore,
                     src: PathSpec,
                     type: str | None = None) -> list[str]:
    results = await walk_find(src,
                              readdir=readdir,
                              stat=stat,
                              index=index,
                              args=parse_find_args((), type=type))
    return [
        "/" + rekey(src.virtual, src.resource_path, path) for path in results
    ]


def _make_find(ops: CommandIO, accessor: Accessor,
               index: IndexCacheStore) -> OperationFn:
    if ops.find is not None:
        return partial(ops.find, accessor)
    return partial(_walk_find, partial(ops.readdir, accessor),
                   partial(ops.stat, accessor), index)


def overlayable_stat(ops: CommandIO, accessor: Accessor,
                     index: IndexCacheStore,
                     stat_overlay: StatOverlay | None) -> OperationFn:
    """The backend stat, merged with the namespace attr overlay if any.

    cp/mv freshness checks (``-u``) must see touch/chmod overlay state,
    exactly like ls and stat rendering.

    Args:
        ops (CommandIO): Backend command IO facade.
        accessor (Accessor): Backend handle.
        index (IndexCacheStore): Cache index threaded through.
        stat_overlay (StatOverlay | None): Namespace merge, or None.
    """
    if stat_overlay is None:
        return bound_op(ops.stat, accessor, index)
    return partial(overlaid_stat,
                   partial(ops.stat, accessor),
                   stat_overlay,
                   index=index)


async def cp(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = NULL_INDEX,
    stat_overlay: StatOverlay | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("cp: no resource")
    fl = FlagView(flags, spec=SPECS["cp"])
    parsed = parse_cp_flags(fl)
    paths = await ops.resolve_glob(accessor, paths, index)
    dir_copy = partial(ops.dir_copy, accessor) if ops.dir_copy else None
    mkdir = partial(ops.mkdir, accessor) if ops.mkdir else None
    strategy = NativeCopy(copy=partial(ops.require(Operation.COPY), accessor),
                          find=_make_find(ops, accessor, index),
                          dir_copy=dir_copy,
                          mkdir=mkdir)
    return await generic_cp(paths,
                            strategy=strategy,
                            stat=overlayable_stat(ops, accessor, index,
                                                  stat_overlay),
                            flags=parsed,
                            readdir=bound_op(ops.readdir, accessor, index))


BUILDER = Builder('cp',
                  cp,
                  write=True,
                  requirements=frozenset({Operation.COPY}))
