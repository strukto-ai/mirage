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
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                parse_flags, wc_generic)
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.postgres.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres import _client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.scope import PostgresEntityRowsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc", resource="postgres", spec=SPECS["wc"])
async def wc(accessor: PostgresAccessor, paths: list[PathSpec],
             texts: list[str],
             opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    # Line counts on tables/views come from a server-side COUNT(*) instead
    # of reading every row. -l only (default prints words and bytes too,
    # which needs the content).
    count_only = parsed.lines and not (parsed.words or parsed.bytes_ or
                                       parsed.chars or parsed.max_line_length)
    scopes = [detect_scope(p) for p in resolved]
    row_scopes = [
        scope for scope in scopes if isinstance(scope, PostgresEntityRowsScope)
    ]
    if resolved and count_only and len(row_scopes) == len(scopes):
        rows: list[tuple[WCCounts, str | None]] = []
        total = 0
        pool = await accessor.pool()
        async with pool.acquire() as conn:
            for p, scope in zip(resolved, row_scopes):
                count = await _client.count_rows(conn, scope.schema,
                                                 scope.entity)
                rows.append((WCCounts(lines=count), p.raw_path))
                total += count
        return format_count_rows(rows, WCCounts(lines=total), len(resolved),
                                 parsed), IOResult()
    return await wc_generic(resolved, list(texts), opts,
                            bound_op(postgres_read, accessor, opts.index))
