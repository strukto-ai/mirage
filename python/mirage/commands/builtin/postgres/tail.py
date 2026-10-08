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
from mirage.commands.builtin.generic.tail import parse_flags, tail_generic
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    mount_io,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.limit import row_cap_notice
from mirage.commands.builtin.utils.paths import has_unresolved_glob
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.core.postgres import client
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.readdir import entity_exists
from mirage.core.postgres.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", vfs="postgres", spec=SPECS["tail"])
async def tail(
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
    if paths:
        scope = detect_scope(paths[0])
        # Row scopes fetch only the last N rows server-side (COUNT then
        # OFFSET) instead of reading the whole relation. A follow polls
        # the file as it grows, and a moving suffix has no byte position
        # to measure against, so it reads the relation whole.
        if (
            len(paths) == 1
            and not has_unresolved_glob(paths)
            and scope.kind == "entity_rows"
            and counts.byte_count is None
            and counts.from_byte is None
            and counts.lines is not None
            and not parsed.follow
            and await entity_exists(accessor, scope, paths[0].virtual)
        ):
            schema = scope.slots["schema"]
            entity = scope.slots["entity"]
            cap = accessor.config.max_read_rows
            pool = await accessor.pool()
            async with pool.acquire() as conn:
                total = await client.count_rows(conn, schema, entity)
                # max_read_rows is the most rows one read may return; a
                # suffix longer than that prints the ceiling and says so,
                # where the ceiling (default_row_limit) used to stand in
                # for the count with exit 0.
                limit = min(counts.lines, total)
                io = IOResult()
                if limit > cap:
                    limit = cap
                    io = IOResult(
                        exit_code=1,
                        stderr=row_cap_notice(
                            "tail",
                            paths[0].raw_path,
                            cap,
                            "rows",
                            "max_read_rows",
                        ),
                    )
                rows = await client.fetch_rows(
                    conn, schema, entity, limit=limit, offset=total - limit
                )
            data = b""
            if rows:
                data = (
                    "\n".join(
                        orjson.dumps(r, default=str).decode() for r in rows
                    )
                    + "\n"
                ).encode()
            return generic_tail(
                data,
                n=counts.lines,
                c=counts.byte_count,
                from_line=counts.from_line,
                from_byte=counts.from_byte,
            ), io
    resolved = await resolve_or_empty(
        mount_io(opts), accessor, paths, opts.index
    )
    return await tail_generic(
        resolved,
        list(texts),
        opts,
        bound_op(mount_io(opts).stat, accessor, opts.index),
        bound_op(postgres_read, accessor, opts.index),
    )
