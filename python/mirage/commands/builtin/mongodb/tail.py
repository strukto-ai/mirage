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
from mirage.commands.builtin.generic_bind.adapter import (bound_op,
                                                          resolve_or_empty)
from mirage.commands.builtin.mongodb.io import IO
from mirage.commands.builtin.utils.limit import row_cap_notice
from mirage.commands.config import CommandOpts
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.read import stream_any
from mirage.core.mongodb.readdir import documents_exist
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_tail, watch_stream
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("tail", vfs="mongodb", spec=SPECS["tail"])
async def tail(accessor: MongoDBAccessor, paths: list[PathSpec],
               texts: list[str],
               opts: CommandOpts) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(opts.flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    counts = parsed.counts
    resolved = await resolve_or_empty(IO, accessor, paths, opts.index)
    # Both fast paths query the collection by the names in the path, so
    # they run only for one the mount can see; anything else takes the
    # generic, which stats it through the same guard and reports it the
    # way GNU names a missing file.
    scope = detect_scope(resolved[0]) if len(resolved) == 1 else None
    fast = (scope is not None and scope.kind == "documents"
            and await documents_exist(accessor, scope, resolved[0].virtual))
    if fast and parsed.follow:
        return watch_stream(accessor, resolved[0], opts.index), IOResult()
    # Collections fetch only the last N documents server-side (sort by
    # primary key descending + limit) instead of reading everything.
    n_eff = counts.lines if counts.lines is not None else 10
    if (fast and counts.byte_count is None and counts.from_byte is None
            and counts.from_line is None and n_eff > 0):
        data, stopped = await read_tail(accessor, resolved[0], n_eff,
                                        opts.index)
        io = IOResult()
        if stopped:
            io = IOResult(exit_code=1,
                          stderr=row_cap_notice("tail", resolved[0].raw_path,
                                                accessor.config.max_doc_limit,
                                                "documents", "max_doc_limit"))
        return generic_tail(data, n=n_eff, c=None, from_line=None), io
    return await tail_generic(resolved, list(texts), opts,
                              bound_op(IO.stat, accessor, opts.index),
                              bound_op(stream_any, accessor, opts.index))
