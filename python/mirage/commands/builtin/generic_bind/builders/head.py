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
from mirage.commands.builtin.generic.head import head_multi
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          bound_op)
from mirage.commands.builtin.generic_bind.builders.common import split_readable
from mirage.commands.builtin.tail_helper import number_flag_error
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def head(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    n: str | None = None,
    c: str | None = None,
    q: bool = False,
    v: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    num_err = number_flag_error("head", n, c)
    if num_err is not None:
        return None, IOResult(exit_code=1, stderr=num_err.encode())
    n_int = int(n) if n is not None else None
    c_int = int(c) if c is not None else None
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        show_headers = (v or len(paths) > 1) and not q
        paths, err = await split_readable(ops, accessor, paths, index, "head")
        io = IOResult(exit_code=1 if err else 0, stderr=err or None)
        if not paths:
            return None, io
        return head_multi(paths,
                          read=bound_op(ops.read_stream, accessor, index),
                          n=n_int,
                          c=c_int,
                          show_headers=show_headers), io
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source, n=n_int, c=c_int), IOResult()


BUILDER = Builder('head', head, None, False, header_aggregate, read=True)
