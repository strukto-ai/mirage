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
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.history.read import read as history_read
from mirage.core.history.stat import stat as history_stat
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cat",
         resource="history",
         spec=SPECS["cat"],
         provision=make_file_read_provision(history_stat))
async def cat(
    accessor: HistoryAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        reads = {
            p.mount_path: await history_read(accessor, p, index)
            for p in paths
        }
        merged = b"".join(reads.values())
        io = IOResult(reads=reads)
        if n:
            return generic_cat(merged, number_lines=True), io
        return merged, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return generic_cat(source, number_lines=True), IOResult()
    return source, IOResult()
