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
from mirage.commands.builtin.generic.wc import (
    WCCounts,
    format_count_rows,
    parse_flags,
    wc_generic,
)
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
    guard_operation,
    resolve_or_empty,
)
from mirage.commands.config import CommandOpts
from mirage.core.postgres import client
from mirage.core.postgres.readdir import entity_exists
from mirage.core.postgres.scope import detect_scope
from mirage.io.types import ByteSource, CountedRun, IOResult
from mirage.types import PathSpec


async def _count(accessor: PostgresAccessor, path: PathSpec) -> int | None:
    scope = detect_scope(path)
    if not await entity_exists(accessor, scope, path.virtual):
        return None
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        return await client.count_rows(
            conn, scope.slots["schema"], scope.slots["entity"]
        )


async def wc(
    ops: CommandIO,
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    resolved = await resolve_or_empty(ops, accessor, paths, opts.index)
    # Line counts on tables/views come from a server-side COUNT(*) instead
    # of reading every row. -l only (default prints words and bytes too,
    # which needs the content).
    count_only = parsed.lines and not (
        parsed.words or parsed.bytes_ or parsed.chars or parsed.max_line_length
    )
    if (
        resolved
        and count_only
        and all(detect_scope(p).kind == "entity_rows" for p in resolved)
    ):
        rows: list[tuple[WCCounts, str | None]] = []
        total = 0
        count = guard_operation(_count, "read_bytes")
        for p in resolved:
            n = await count(accessor, p)
            if n is None:
                break
            rows.append((WCCounts(lines=n), p.raw_path))
            total += n
        else:
            runs = [
                CountedRun((counts.lines,), label) for counts, label in rows
            ]
            return format_count_rows(
                rows, WCCounts(lines=total), len(resolved), parsed
            ), IOResult(counted_runs=runs)
    return await wc_generic(
        resolved,
        list(texts),
        opts,
        bound_op(ops.read_stream, accessor, opts.index),
    )


BUILDER = Builder("wc", wc, read=True)
