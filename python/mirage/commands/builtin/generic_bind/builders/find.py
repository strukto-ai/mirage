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
from mirage.commands.builtin.generic.find import (find_generic,
                                                  find_walk_generic)
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          overlaid_stat)
from mirage.commands.config import CommandOpts
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import NamespaceView, StatPath
from mirage.types import PathSpec


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


async def find(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    index: IndexCacheStore = NULL_INDEX,
    ns: NamespaceView | None = None,
    stat_path: StatPath | None = None,
    **flags: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    stat_overlay = ns.stat_overlay if ns is not None else None
    links = ns.links if ns is not None else None
    if not ops.is_mounted(accessor):
        raise ValueError("find: no resource")
    resolved = await ops.resolve_glob(accessor, paths, index)
    opts = CommandOpts(stdin=stdin, flags=flags)
    if ops.find is None:
        # -mtime must see namespace times (touch results, observed
        # writes on mtime-less backends), same as ls.
        walk_stat = partial(ops.stat, accessor)
        if stat_overlay is not None:
            walk_stat = partial(overlaid_stat, walk_stat, stat_overlay)
        return await find_walk_generic(resolved,
                                       list(texts),
                                       opts,
                                       readdir=partial(ops.readdir, accessor),
                                       stat=walk_stat,
                                       index=index,
                                       stat_path=stat_path,
                                       links=links)
    stat = (partial(ops.stat, accessor, index=index) if ops.local else None)
    if stat is not None and stat_overlay is not None:
        stat = partial(overlaid_stat,
                       partial(ops.stat, accessor),
                       stat_overlay,
                       index=index)
    return await find_generic(resolved,
                              list(texts),
                              opts,
                              find_core=partial(ops.find, accessor),
                              stat=stat,
                              stat_path=stat_path,
                              dir_empty=partial(_dir_is_empty, ops, accessor,
                                                index),
                              links=links)


BUILDER = Builder('find', find, None, False, None)
