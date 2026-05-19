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

from mirage.accessor.disk import DiskAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.aggregators import concat_aggregate
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.stat import stat as local_stat
from mirage.core.disk.stream import read_stream
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _chain_streams(accessor: DiskAccessor,
                         paths: list[PathSpec]) -> AsyncIterator[bytes]:
    for p in paths:
        async for chunk in read_stream(accessor, p):
            yield chunk


@command("cat", resource="disk", spec=SPECS["cat"], aggregate=concat_aggregate)
async def cat(
    accessor: DiskAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and accessor.root is not None:
        paths = await resolve_glob(accessor, paths, index)
        for p in paths:
            await local_stat(accessor, p, index)
        source = _chain_streams(accessor, paths)
        cachable = CachableAsyncIterator(source)
        io = IOResult(reads={p.strip_prefix: cachable
                             for p in paths},
                      cache=[p.strip_prefix for p in paths])
        if n:
            return generic_cat(cachable, number_lines=True), io
        return cachable, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return generic_cat(source, number_lines=True), IOResult()
    return source, IOResult()
