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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.aggregators import concat_aggregate
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.ssh._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.ssh.glob import resolve_glob
from mirage.core.ssh.read import read_bytes
from mirage.core.ssh.stat import stat as local_stat
from mirage.core.ssh.stream import read_stream
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cat",
         resource="ssh",
         spec=SPECS["cat"],
         aggregate=concat_aggregate,
         provision=file_read_provision)
async def cat(
    accessor: SSHAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths and accessor.root is not None:
        paths = await resolve_glob(accessor, paths, index)
        # ssh is a remote (cacheable) backend. Single file: stream via a
        # cachable returned AS stdout so the tee fills the cache as it is
        # read. Multiple files: one shared cachable cannot give each path its
        # own correct cache slot, and the cache-fill background drain races the
        # consumer on the same network stream. Read each file fully to bytes:
        # cache each path's real bytes directly (no drain, no race).
        if len(paths) == 1:
            p = paths[0]
            await local_stat(accessor, p, index)
            cachable = CachableAsyncIterator(read_stream(accessor, p, index))
            io = IOResult(reads={p.strip_prefix: cachable},
                          cache=[p.strip_prefix])
            source: ByteSource = cachable
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                await local_stat(accessor, p, index)
                data = await read_bytes(accessor, p, index)
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
