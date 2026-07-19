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
from mirage.commands.builtin.generic.find import parse_find_args, walk_find
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.builtin.utils.output import format_records
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.path import rebase_raw


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
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if not ops.is_mounted(accessor):
        raise ValueError("find: no resource")
    paths = await ops.resolve_glob(accessor, paths, index)
    if ops.find is None:
        return await _find_walk(ops, accessor, paths, texts, name, type, size,
                                mtime, maxdepth, iname, path, mindepth, empty,
                                index)
    stat = (partial(ops.stat, accessor, index=index) if ops.local else None)
    return await generic_find(paths,
                              texts,
                              find_core=partial(ops.find, accessor),
                              stat=stat,
                              name=name,
                              type=type,
                              size=size,
                              mtime=mtime,
                              maxdepth=maxdepth,
                              iname=iname,
                              path=path,
                              mindepth=mindepth,
                              empty=empty)


def _no_dir_hint(_name: str) -> bool | None:
    return None


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
    hint = (partial(ops.is_dir_name, accessor)
            if ops.is_dir_name is not None else _no_dir_hint)
    # GNU find walks every start point in operand order.
    results: list[str] = []
    for search in searches:
        walked = await walk_find(search,
                                 readdir=partial(ops.readdir, accessor),
                                 stat=partial(ops.stat, accessor),
                                 is_dir_name=hint,
                                 index=index,
                                 args=args)
        # GNU prints each result under the operand as typed; walk_find
        # returns virtual paths, so rebase like generic_find does.
        results.extend(rebase_raw(walked, search.virtual, search.raw_path))
    return format_records(results), IOResult()


BUILDER = Builder('find', find, None, False, None)
