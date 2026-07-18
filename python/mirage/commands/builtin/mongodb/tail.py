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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.mongodb._provision import head_tail_provision
from mirage.commands.builtin.mongodb.io import resolve_glob
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_tail, watch_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail",
         resource="mongodb",
         spec=SPECS["tail"],
         provision=head_tail_provision)
async def tail(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    f: bool = False,
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int: int | None = None
    from_line: int | None = None
    if n is not None:
        lines, plus_mode = _parse_n(n)
        if plus_mode:
            from_line = lines
        else:
            n_int = lines
    c_int = int(c) if c is not None else None
    if paths:
        paths = await resolve_glob(accessor, paths, index=index)
        if (f and len(paths) == 1
                and detect_scope(paths[0]).level == ScopeLevel.DOCUMENTS):
            return watch_stream(accessor, paths[0], index), IOResult()
        # Collections fetch only the last N documents server-side (sort by
        # primary key descending + limit) instead of reading everything.
        n_eff = n_int if n_int is not None else 10
        if (len(paths) == 1 and c_int is None and from_line is None
                and n_eff > 0
                and detect_scope(paths[0]).level == ScopeLevel.DOCUMENTS):
            data = await read_tail(accessor, paths[0], n_eff, index)
            return generic_tail(data, n=n_eff, c=None,
                                from_line=None), IOResult()
        show_headers = (v or len(paths) > 1) and not q
        return tail_multi(paths,
                          read=bound_op(mongodb_read, accessor, index),
                          n=n_int,
                          c=c_int,
                          from_line=from_line,
                          show_headers=show_headers), IOResult()
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()
