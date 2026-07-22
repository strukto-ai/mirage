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
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.wc import (WCCounts, format_count_rows,
                                                format_stdin, parse_flags)
from mirage.commands.builtin.generic.wc import wc as generic_wc
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
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
    stdin: ByteSource | None = None,
    index: IndexCacheStore,
    **flags: object,
) -> tuple[ByteSource | None, IOResult]:
    try:
        parsed = parse_flags(flags)
    except ValueError as exc:
        return None, IOResult(exit_code=1, stderr=(str(exc) + "\n").encode())
    if paths:
        rows: list[tuple[WCCounts, str | None]] = []
        totals = WCCounts()
        for p in paths:
            counts = await generic_wc(await history_read(accessor, p, index))
            rows.append((counts, p.virtual))
            totals.merge(counts)
        return format_count_rows(rows, totals, len(paths), parsed), IOResult()
    data = await _read_stdin_async(stdin)
    if data is None:
        raise ValueError("wc: missing operand")
    counts = await generic_wc(data)
    return format_stdin(counts, parsed), IOResult()
