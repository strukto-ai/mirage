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
from mirage.commands.builtin.aggregators import concat_aggregate
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.generic_bind.adapter import Builder, CommandIO
from mirage.commands.builtin.generic_bind.builders.common import split_readable
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
    stdin: ByteSource | None = None,
    n: bool = False,
    E: bool = False,
    T: bool = False,
    v: bool = False,
    e: bool = False,
    t: bool = False,
    A: bool = False,
    s: bool = False,
    index: IndexCacheStore = NULL_INDEX,
    **kwargs,
) -> tuple[ByteSource | None, IOResult]:
    # GNU combinations: -e is -vE, -t is -vT, -A is -vET.
    display = dict(
        number_lines=n,
        show_ends=E or e or A,
        show_tabs=T or t or A,
        show_nonprinting=v or e or t or A,
        squeeze_blank=s,
    )
    wants_display = any(display.values())
    if paths and ops.is_mounted(accessor):
        paths = await ops.resolve_glob(accessor, paths, index)
        paths, err = await split_readable(ops, accessor, paths, index, "cat")
        if not paths:
            return None, IOResult(exit_code=1 if err else 0,
                                  stderr=err or None)
        if len(paths) == 1:
            p = paths[0]
            cachable = CachableAsyncIterator(
                ops.read_stream(accessor, p, index))
            io = IOResult(reads={p.mount_path: cachable}, cache=[p.mount_path])
            source: ByteSource = cachable
        elif ops.local:
            cachables = [
                CachableAsyncIterator(ops.read_stream(accessor, p, index))
                for p in paths
            ]
            io = IOResult(reads={
                p.mount_path: c
                for p, c in zip(paths, cachables)
            },
                          cache=[p.mount_path for p in paths])
            source = chain_cachables(*cachables)
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                data = await ops.read_bytes(accessor, p, index)
                reads[p.mount_path] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        if err:
            io.stderr = err
            io.exit_code = 1
        if wants_display:
            return generic_cat(source, **display), io
        return source, io
    source = _resolve_source(stdin, "cat: missing operand")
    if wants_display:
        return generic_cat(source, **display), IOResult()
    return source, IOResult()


BUILDER = Builder('cat', cat, None, False, concat_aggregate, read=True)
