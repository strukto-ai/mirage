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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.find import (find_generic,
                                                  find_walk_generic)
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileStat, PathSpec


async def _dir_is_empty(ops: CommandIO, accessor: Accessor,
                        index: IndexCacheStore, search: PathSpec) -> bool:
    """Whether a directory start point holds nothing, for ``-empty``.

    Only the native-op path needs this: the walk answers the same
    question with the readdir it already takes (``_is_empty_entry``).
    Asked once, for the start point, and only when the expression
    mentions ``-empty``.

    Args:
        ops (CommandIO): the backend's op table.
        accessor (Accessor): the mounted backend.
        index (IndexCacheStore): cache index threaded through reads.
        search (PathSpec): the directory start point.
    """
    return not await ops.readdir(accessor, search, index=index)


async def find(ops: CommandIO, accessor: Accessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("find: no resource")
    resolved = await ops.resolve_glob(accessor, paths, opts.index)
    overlay = opts.ns.stat_overlay if opts.ns is not None else None
    if ops.find is None:
        # -mtime must see namespace times (touch results, observed
        # writes on mtime-less backends), same as ls.
        walk_stat: Callable[...,
                            Awaitable[FileStat]] = partial(ops.stat, accessor)
        if overlay is not None:
            walk_stat = partial(overlaid_stat, walk_stat, overlay)
        return await find_walk_generic(resolved,
                                       list(texts),
                                       opts,
                                       readdir=partial(ops.readdir, accessor),
                                       stat=walk_stat)
    stat: Callable[..., Awaitable[FileStat]] | None = (partial(
        ops.stat, accessor, index=opts.index) if ops.local else None)
    if stat is not None and overlay is not None:
        stat = partial(overlaid_stat,
                       partial(ops.stat, accessor),
                       overlay,
                       index=opts.index)
    return await find_generic(resolved,
                              list(texts),
                              opts,
                              find_core=partial(ops.find, accessor),
                              stat=stat,
                              dir_empty=partial(_dir_is_empty, ops, accessor,
                                                opts.index))


BUILDER = Builder('find', find, None, False, None)
