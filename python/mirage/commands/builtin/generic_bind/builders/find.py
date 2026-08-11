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
from mirage.commands.builtin.generic.find import find as generic_find
from mirage.commands.builtin.generic.find import (is_link, missing_start_line,
                                                  parse_find_args,
                                                  resolve_start, walk_find)
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          overlaid_stat)
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView, StatOverlay, StatPath
from mirage.types import PathSpec
from mirage.utils.path import respell_raw


async def find(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: bytes | None = None,
    name: str | None = None,
    type: str | None = None,
    maxdepth: str | None = None,
    size: str | None = None,
    mtime: str | None = None,
    iname: str | None = None,
    path: str | None = None,
    mindepth: str | None = None,
    empty: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    stat_overlay: StatOverlay | None = None,
    links: LinkView | None = None,
    stat_path: StatPath | None = None,
    L: bool = False,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("find: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    if ops.find is None:
        return await _find_walk(ops, accessor, paths, texts, name, type, size,
                                mtime, maxdepth, iname, path, mindepth, empty,
                                index, stat_overlay, links, stat_path, L)
    stat = (partial(ops.stat, accessor, index=index) if ops.local else None)
    if stat is not None and stat_overlay is not None:
        # -mtime must see namespace times (touch results, observed
        # writes on mtime-less backends), same as ls.
        stat = partial(overlaid_stat,
                       partial(ops.stat, accessor),
                       stat_overlay,
                       index=index)
    return await generic_find(paths,
                              texts,
                              find_core=partial(ops.find, accessor),
                              stat=stat,
                              stat_path=stat_path,
                              dir_empty=partial(_dir_is_empty, ops, accessor,
                                                index),
                              name=name,
                              type=type,
                              size=size,
                              mtime=mtime,
                              maxdepth=maxdepth,
                              iname=iname,
                              path=path,
                              mindepth=mindepth,
                              empty=empty,
                              links=links,
                              follow=L)


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


async def _find_walk(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: tuple[str, ...],
    name: str | None,
    type: str | None,
    size: str | None,
    mtime: str | None,
    maxdepth: str | None,
    iname: str | None,
    path: str | None,
    mindepth: str | None,
    empty: bool,
    index: IndexCacheStore,
    stat_overlay: StatOverlay | None = None,
    links: LinkView | None = None,
    stat_path: StatPath | None = None,
    L: bool = False,
    H: bool = False,
) -> tuple[ByteSource | None, IOResult]:
    searches = paths if paths else [
        PathSpec(virtual="/", directory="/", resource_path="")
    ]
    args = parse_find_args(texts,
                           name=name,
                           type=type,
                           size=size,
                           mtime=mtime,
                           maxdepth=maxdepth,
                           iname=iname,
                           path=path,
                           mindepth=mindepth,
                           empty=empty)
    stat_fn = partial(ops.stat, accessor)
    if stat_overlay is not None:
        stat_fn = partial(overlaid_stat, stat_fn, stat_overlay)
    # GNU find walks every start point in operand order.
    results: list[str] = []
    missing: list[str] = []
    for search in searches:
        # Same start-point rule as the native-op path, so what `find` does
        # with a file or a missing operand does not depend on whether the
        # mounted backend ships a find op.
        start = await resolve_start(search,
                                    args,
                                    stat_path,
                                    is_link=is_link(links, search))
        if start.missing:
            # GNU names each start point it cannot stat, keeps going with
            # the rest, and exits 1.
            missing.append(missing_start_line(search))
            continue
        if not start.walk:
            results.extend(start.results)
            continue
        walked = await walk_find(search,
                                 readdir=partial(ops.readdir, accessor),
                                 stat=stat_fn,
                                 index=index,
                                 args=args,
                                 links=links,
                                 follow=L)
        # GNU prints each result under the operand as typed; walk_find
        # returns virtual paths, so rebase like generic_find does.
        results.extend(respell_raw(walked, search.virtual, search.raw_path))
    if missing:
        return format_records(results), IOResult(stderr=("\n".join(missing) +
                                                         "\n").encode(),
                                                 exit_code=1)
    return format_records(results), IOResult()


BUILDER = Builder('find', find, None, False, None)
