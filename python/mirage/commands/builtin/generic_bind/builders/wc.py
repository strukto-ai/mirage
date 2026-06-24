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

from collections.abc import AsyncIterator

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.aggregators import wc_aggregate
from mirage.commands.builtin.generic.wc import format_multi, format_wc
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.generic.wc import wc_lines as generic_wc_lines
from mirage.commands.builtin.generic_bind.adapter import (Builder, CommandIO,
                                                          with_index)
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def wc(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        body = await format_multi(paths,
                                  read=with_index(ops.read_stream, index),
                                  accessor=accessor,
                                  args_l=args_l,
                                  w=w,
                                  c=c,
                                  m=m,
                                  L=L)
        return body, IOResult()
    source: AsyncIterator[bytes] = _resolve_source(stdin,
                                                   "wc: missing operand")
    if args_l and not (L or w or c or m):
        line_count = await generic_wc_lines(source)
        return str(line_count).encode() + b"\n", IOResult()
    counts = await generic_wc(source)
    return (format_wc(counts, args_l=args_l, w=w, c=c, m=m, L=L).encode() +
            b"\n", IOResult())


BUILDER = Builder('wc', wc, make_file_read_provision, False, wc_aggregate)
