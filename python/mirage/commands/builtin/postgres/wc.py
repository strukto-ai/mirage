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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.wc import (WCCounts, format_wc,
                                                format_wc_lines)
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.postgres._provision import file_read_provision
from mirage.commands.builtin.postgres.io import resolve_glob
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres import _client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.scope import PostgresEntityRowsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc",
         resource="postgres",
         spec=SPECS["wc"],
         provision=file_read_provision)
async def wc(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        # Line counts on tables/views come from a server-side COUNT(*)
        # instead of reading every row. -l only (default prints words and
        # bytes too, which needs the content).
        count_only = args_l and not (w or c or m or L)
        scopes = [detect_scope(p) for p in paths]
        row_scopes = [
            scope for scope in scopes
            if isinstance(scope, PostgresEntityRowsScope)
        ]
        rows: list[tuple[WCCounts, str | None]] = []
        if count_only and len(row_scopes) == len(scopes):
            total = 0
            pool = await accessor.pool()
            async with pool.acquire() as conn:
                for p, scope in zip(paths, row_scopes):
                    count = await _client.count_rows(conn, scope.schema,
                                                     scope.entity)
                    rows.append((WCCounts(lines=count), p.virtual))
                    total += count
            if len(paths) > 1:
                rows.append((WCCounts(lines=total), "total"))
            return format_records(format_wc_lines(rows,
                                                  args_l=True)), IOResult()
        totals = WCCounts()
        for p in paths:
            data = await postgres_read(accessor, p, index)
            counts = await generic_wc(data)
            rows.append((counts, p.virtual))
            totals.merge(counts)
        if len(paths) > 1:
            rows.append((totals, "total"))
        return format_records(
            format_wc_lines(rows, args_l=args_l, w=w, c=c, m=m,
                            L=L)), IOResult()
    stdin_data = await _read_stdin_async(stdin)
    if stdin_data is None:
        raise ValueError("wc: missing operand")
    counts = await generic_wc(stdin_data)
    return format_wc(counts, args_l=args_l, w=w, c=c, m=m,
                     L=L).encode() + b"\n", IOResult()
