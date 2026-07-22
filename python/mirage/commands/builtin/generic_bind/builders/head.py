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

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.aggregators import header_aggregate
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi, parse_flags
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import split_readable
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def head(
    ops: CommandIO,
    accessor: Accessor,
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
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        show_headers = (parsed.verbose or len(paths) > 1) and not parsed.quiet
        paths, err = await split_readable(ops, accessor, paths, index, "head")
        io = IOResult(exit_code=1 if err else 0, stderr=err or None)
        if not paths:
            return None, io
        return head_multi(paths,
                          read=bound_op(ops.read_stream, accessor, index),
                          n=parsed.lines,
                          c=parsed.bytes_,
                          show_headers=show_headers,
                          zero_terminated=parsed.zero_terminated), io
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source,
                        n=parsed.lines,
                        c=parsed.bytes_,
                        zero_terminated=parsed.zero_terminated), IOResult()


BUILDER = Builder('head', head, None, False, header_aggregate, read=True)
