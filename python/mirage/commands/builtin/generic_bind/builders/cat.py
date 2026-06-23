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
from mirage.commands.builtin.aggregators import concat_aggregate
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.builtin.generic_bind.provision import \
    make_file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain, chain_cachables
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def cat(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore | None = None,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        if ops.local:
            for p in paths:
                await ops.stat(accessor, p, index)
        if len(paths) == 1:
            p = paths[0]
            if not ops.local:
                await ops.stat(accessor, p, index)
            cachable = CachableAsyncIterator(ops.read_stream(accessor, p))
            io = IOResult(reads={p.strip_prefix: cachable},
                          cache=[p.strip_prefix])
            source: ByteSource = cachable
        elif ops.local:
            cachables = [
                CachableAsyncIterator(ops.read_stream(accessor, p))
                for p in paths
            ]
            io = IOResult(reads={
                p.strip_prefix: c
                for p, c in zip(paths, cachables)
            },
                          cache=[p.strip_prefix for p in paths])
            source = chain_cachables(*cachables)
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                data = await ops.read_bytes(accessor, p, index)
                reads[p.strip_prefix] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        if n:
            return generic_cat(source, number_lines=True), io
        return source, io
    source = _resolve_source(stdin, "cat: missing operand")
    if n:
        return generic_cat(source, number_lines=True), IOResult()
    return source, IOResult()


BUILDER = Builder('cat', cat, make_file_read_provision, False,
                  concat_aggregate)
