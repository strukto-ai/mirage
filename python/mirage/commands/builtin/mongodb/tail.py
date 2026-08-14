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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.commands.builtin.generic.tail import parse_flags
from mirage.commands.builtin.generic.tail import tail as generic_tail
from mirage.commands.builtin.generic.tail import tail_generic
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.builders.common import \
    resolve_or_empty
from mirage.commands.builtin.mongodb.cat import stream_any
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_tail, watch_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", resource="mongodb", spec=SPECS["tail"])
async def tail(accessor: MongoDBAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    if (parsed.follow and len(resolved) == 1
            and detect_scope(resolved[0]).level == ScopeLevel.DOCUMENTS):
        return watch_stream(accessor, resolved[0], opts.index), IOResult()
    # Collections fetch only the last N documents server-side (sort by
    # primary key descending + limit) instead of reading everything.
    n_eff = counts.lines if counts.lines is not None else 10
    if (len(resolved) == 1 and counts.byte_count is None
            and counts.from_byte is None and counts.from_line is None
            and n_eff > 0
            and detect_scope(resolved[0]).level == ScopeLevel.DOCUMENTS):
        data = await read_tail(accessor, resolved[0], n_eff, opts.index)
        return generic_tail(data, n=n_eff, c=None, from_line=None), IOResult()
    return await tail_generic(resolved, list(texts), opts,
                              bound_op(IO.stat, accessor, opts.index),
                              bound_op(stream_any, accessor, opts.index))
