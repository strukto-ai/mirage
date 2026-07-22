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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.aggregators import wc_aggregate
from mirage.commands.builtin.generic.wc import (format_multi, format_stdin,
                                                parse_flags)
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.builtin.generic_bind.builders.common import \
    dir_refusing_read
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def wc(
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
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        body, err = await format_multi(paths,
                                       read=dir_refusing_read(
                                           ops, accessor, index),
                                       args_l=parsed.lines,
                                       w=parsed.words,
                                       c=parsed.bytes_,
                                       m=parsed.chars,
                                       L=parsed.max_line_length,
                                       total=parsed.total)
        return body, IOResult(exit_code=1 if err else 0, stderr=err or None)
    source: AsyncIterator[bytes] = _resolve_source(stdin,
                                                   "wc: missing operand")
    counts = await generic_wc(source)
    return format_stdin(counts, parsed), IOResult()


BUILDER = Builder('wc', wc, None, False, wc_aggregate, read=True)
