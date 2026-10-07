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

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.tail import parse_flags, tail_generic
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
    guard_operation,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.limit import note_after, row_cap_notice
from mirage.commands.config import CommandOpts
from mirage.core.postgres import client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.readdir import entity_exists
from mirage.core.postgres.scope import detect_scope
from mirage.errors.fs import enoent
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _tail_rows(
    accessor: PostgresAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    *,
    n: int,
    notices: list[bytes],
) -> bytes:
    scope = detect_scope(path)
    if scope.kind != "entity_rows":
        return await postgres_read(accessor, path, index)
    if not await entity_exists(accessor, scope, path.virtual):
        raise enoent(path)
    schema, entity = scope.slots["schema"], scope.slots["entity"]
    cap = accessor.config.max_read_rows
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        total = await client.count_rows(conn, schema, entity)
    limit = min(n, total, cap)
    if min(n, total) > cap:
        notices.append(
            row_cap_notice("tail", path.raw_path, cap, "rows", "max_read_rows")
        )
    return await postgres_read(
        accessor, path, index, limit=limit, offset=total - limit
    )


async def tail(
    ops: CommandIO,
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    n = counts.lines if counts.lines is not None else 10
    read = ops.read_bytes
    notices: list[bytes] = []
    if (
        counts.byte_count is None
        and counts.from_byte is None
        and n > 0
        and counts.from_line is None
        and not parsed.follow
    ):
        read = partial(
            guard_operation(_tail_rows, "read_bytes"),
            n=n,
            notices=notices,
        )
    resolved = await resolve_or_empty(ops, accessor, paths, opts.index)
    out, io = await tail_generic(
        resolved,
        texts,
        opts,
        bound_op(ops.stat, accessor, opts.index),
        bound_op(read, accessor, opts.index),
    )
    return (note_after(out, io, notices) if out is not None else out), io


BUILDER = Builder("tail", tail, read=True)
