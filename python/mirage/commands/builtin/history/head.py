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

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi, parse_flags
from mirage.commands.builtin.generic_bind.adapter import bound_op
from mirage.commands.builtin.generic_bind.provision import \
    make_head_tail_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.history.read import read as history_read
from mirage.core.history.stat import stat as history_stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("head",
         resource="history",
         spec=SPECS["head"],
         provision=make_head_tail_provision(history_stat))
async def head(
    accessor: HistoryAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    index: IndexCacheStore = NULL_INDEX,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=str(exc).encode())
    if paths:
        return head_multi(paths,
                          read=bound_op(history_read, accessor, index),
                          n=parsed.lines,
                          c=parsed.bytes_,
                          show_headers=(parsed.verbose or len(paths) > 1)
                          and not parsed.quiet,
                          zero_terminated=parsed.zero_terminated), IOResult()
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source,
                        n=parsed.lines,
                        c=parsed.bytes_,
                        zero_terminated=parsed.zero_terminated), IOResult()
