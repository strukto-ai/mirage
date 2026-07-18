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

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_multi
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.postgres._provision import head_tail_provision
from mirage.commands.builtin.postgres.ops import RESOLVE_GLOB as resolve_glob
from mirage.commands.builtin.tail_helper import _parse_n
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres import _client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.scope import PostgresEntityRowsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail",
         resource="postgres",
         spec=SPECS["tail"],
         provision=head_tail_provision)
async def tail(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
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
        scope = detect_scope(paths[0])
        if (len(paths) == 1 and isinstance(scope, PostgresEntityRowsScope)
                and c_int is None and n_int is not None):
            limit = min(n_int, accessor.config.default_row_limit)
            pool = await accessor.pool()
            async with pool.acquire() as conn:
                total = await _client.count_rows(conn, scope.schema,
                                                 scope.entity)
                offset = max(0, total - limit)
                rows = await _client.fetch_rows(conn,
                                                scope.schema,
                                                scope.entity,
                                                limit=limit,
                                                offset=offset)
            if not rows:
                return generic_tail(b"", n=n_int, c=c_int,
                                    from_line=from_line), IOResult()
            jsonl = "\n".join(
                orjson.dumps(r, default=str).decode() for r in rows) + "\n"
            return generic_tail(jsonl.encode(),
                                n=n_int,
                                c=c_int,
                                from_line=from_line), IOResult()

        paths = await resolve_glob(accessor, paths, index=index)
        show_headers = (v or len(paths) > 1) and not q
        return tail_multi(paths,
                          read=bound_op(postgres_read, accessor, index),
                          n=n_int,
                          c=c_int,
                          from_line=from_line,
                          show_headers=show_headers), IOResult()
    source = _resolve_source(stdin, "tail: missing operand")
    return generic_tail(source, n=n_int, c=c_int,
                        from_line=from_line), IOResult()
