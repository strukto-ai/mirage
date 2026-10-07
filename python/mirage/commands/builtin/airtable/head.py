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

from mirage.accessor.airtable import AirtableAccessor
from mirage.commands.builtin.generic.head import head_generic, parse_flags
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    bound_op,
    guard_operation,
    resolve_or_empty,
)
from mirage.commands.config import CommandOpts
from mirage.core.airtable.read import read as airtable_read
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def head(
    ops: CommandIO,
    accessor: AirtableAccessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    # A record renders as exactly one line, so the first N lines of a
    # records file are its first N records: the count rides maxRecords
    # instead of paging the whole table. Files that are not record
    # lists ignore the limit.
    n_eff = parsed.lines if parsed.lines is not None else 10
    read_fn = ops.read_bytes
    if parsed.bytes_ is None and n_eff > 0 and not parsed.zero_terminated:
        read_fn = partial(
            guard_operation(airtable_read, "read_bytes"), limit=n_eff
        )
    resolved = await resolve_or_empty(ops, accessor, paths, opts.index)
    return await head_generic(
        resolved,
        list(texts),
        opts,
        bound_op(ops.stat, accessor, opts.index),
        bound_op(read_fn, accessor, opts.index),
    )


BUILDER = Builder("head", head, read=True)
