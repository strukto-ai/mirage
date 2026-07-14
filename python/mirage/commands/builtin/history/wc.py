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

from mirage.accessor.history import HistoryAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.wc import (WCCounts, format_wc,
                                                format_wc_lines)
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
from mirage.commands.builtin.utils.output import format_records
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.history.read import read as history_read
from mirage.core.history.stat import stat as history_stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("wc",
         resource="history",
         spec=SPECS["wc"],
         provision=make_file_read_provision(history_stat))
async def wc(
    accessor: HistoryAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    args_l: bool = False,
    w: bool = False,
    c: bool = False,
    m: bool = False,
    L: bool = False,
    index: IndexCacheStore | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        rows: list[tuple[WCCounts, str | None]] = []
        totals = WCCounts()
        for p in paths:
            counts = await generic_wc(await history_read(accessor, p, index))
            rows.append((counts, p.virtual))
            totals.merge(counts)
        if len(paths) > 1:
            rows.append((totals, "total"))
        return format_records(
            format_wc_lines(rows, args_l=args_l, w=w, c=c, m=m,
                            L=L)), IOResult()
    data = await _read_stdin_async(stdin)
    if data is None:
        raise ValueError("wc: missing operand")
    counts = await generic_wc(data)
    return format_wc(counts, args_l=args_l, w=w, c=c, m=m,
                     L=L).encode() + b"\n", IOResult()
