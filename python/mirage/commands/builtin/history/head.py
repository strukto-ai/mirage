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
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.generic.head import head_multi
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
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    n_int = int(n) if n is not None else None
    c_int = int(c) if c is not None else None
    if paths:
        return head_multi(paths,
                          read=history_read,
                          accessor=accessor,
                          index=index,
                          n=n_int,
                          c=c_int,
                          show_headers=len(paths) > 1), IOResult()
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source, n=n_int, c=c_int), IOResult()
