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
from mirage.commands.builtin.generic.tail import parse_flags
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_generic
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.postgres.io import IO
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres import _client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.scope import PostgresEntityRowsScope, detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", resource="postgres", spec=SPECS["tail"])
async def tail(accessor: PostgresAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    if paths:
        scope = detect_scope(paths[0])
        # Row scopes fetch only the last N rows server-side (COUNT then
        # OFFSET) instead of reading the whole relation.
        if (len(paths) == 1 and not has_unresolved_glob(paths)
                and isinstance(scope, PostgresEntityRowsScope)
                and counts.byte_count is None and counts.from_byte is None
                and counts.lines is not None):
            limit = min(counts.lines, accessor.config.default_row_limit)
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
            data = b""
            if rows:
                data = ("\n".join(
                    orjson.dumps(r, default=str).decode()
                    for r in rows) + "\n").encode()
            return generic_tail(data,
                                n=counts.lines,
                                c=counts.byte_count,
                                from_line=counts.from_line,
                                from_byte=counts.from_byte), IOResult()
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    return await tail_generic(resolved, list(texts), opts,
                              bound_op(IO.stat, accessor, opts.index),
                              bound_op(postgres_read, accessor, opts.index))
