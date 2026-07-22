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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi, parse_flags
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.postgres._provision import head_tail_provision
from mirage.commands.builtin.postgres.io import resolve_glob
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.postgres.read import read as postgres_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("head",
         resource="postgres",
         spec=SPECS["head"],
         provision=head_tail_provision)
async def head(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        # Row reads push LIMIT into the query instead of fetching the whole
        # relation; non-row scopes ignore the limit kwarg.
        n_eff = parsed.lines if parsed.lines is not None else 10
        read_fn = postgres_read
        if parsed.bytes_ is None and n_eff > 0 and not parsed.zero_terminated:
            read_fn = partial(postgres_read,
                              limit=min(n_eff,
                                        accessor.config.default_row_limit))
        return head_multi(paths,
                          read=bound_op(read_fn, accessor, index),
                          n=parsed.lines,
                          c=parsed.bytes_,
                          show_headers=(parsed.verbose or len(paths) > 1)
                          and not parsed.quiet,
                          zero_terminated=parsed.zero_terminated), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("head: missing operand")
    return generic_head(raw,
                        n=parsed.lines,
                        c=parsed.bytes_,
                        zero_terminated=parsed.zero_terminated), IOResult()
