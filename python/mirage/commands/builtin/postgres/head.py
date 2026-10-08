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
from mirage.commands.builtin.generic.head import head_generic, parse_flags
from mirage.commands.builtin.generic_bind.adapter import (
    bound_op,
    mount_io,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.limit import note_after, row_cap_notice
from mirage.commands.config import CommandOpts, command
from mirage.commands.spec import SPECS
from mirage.core.postgres.read import read as postgres_read
from mirage.core.postgres.scope import detect_scope
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _head_rows(
    accessor: PostgresAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    *,
    n: int,
    notices: list[bytes],
) -> bytes:
    """Read the first ``n`` rows of a relation with the count pushed down.

    ``max_read_rows`` is the most rows one read may return, so a count
    past it fetches one row more than the ceiling: when that row exists
    the output stops at the ceiling and a notice says so, rather than
    the ceiling (``default_row_limit`` it was, too) standing in for the
    count with exit 0. A relation shorter than the ceiling prints whole,
    which is what GNU's head prints for any count past the file's end.

    Args:
        accessor (PostgresAccessor): backend handle.
        path (PathSpec): the operand.
        index (IndexCacheStore): index cache.
        n (int): the line count asked for, positive.
        notices (list[bytes]): where a stopped read records its notice.
    """
    cap = accessor.config.max_read_rows
    if n <= cap or detect_scope(path).kind != "entity_rows":
        return await postgres_read(accessor, path, index, limit=n)
    data = await postgres_read(accessor, path, index, limit=cap + 1)
    lines = data.split(b"\n")
    if len(lines) - 1 <= cap:
        return data
    notices.append(
        row_cap_notice("head", path.raw_path, cap, "rows", "max_read_rows")
    )
    return b"\n".join(lines[:cap]) + b"\n"


@command("head", vfs="postgres", spec=SPECS["head"])
async def head(
    accessor: PostgresAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    # Row reads push LIMIT into the query instead of fetching the whole
    # relation; non-row scopes ignore the limit kwarg.
    n_eff = parsed.lines if parsed.lines is not None else 10
    read_fn = postgres_read
    notices: list[bytes] = []
    if parsed.bytes_ is None and n_eff > 0 and not parsed.zero_terminated:
        read_fn = partial(_head_rows, n=n_eff, notices=notices)
    resolved = await resolve_or_empty(
        mount_io(opts), accessor, paths, opts.index
    )
    out, io = await head_generic(
        resolved,
        list(texts),
        opts,
        bound_op(mount_io(opts).stat, accessor, opts.index),
        bound_op(read_fn, accessor, opts.index),
    )
    if out is None:
        return out, io
    return note_after(out, io, notices), io
