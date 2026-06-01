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

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.nextcloud._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.nextcloud.glob import resolve_glob
from mirage.core.nextcloud.read import read_bytes
from mirage.core.nextcloud.stat import stat
from mirage.core.nextcloud.stream import read_stream
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cat",
         resource="nextcloud",
         spec=SPECS["cat"],
         provision=file_read_provision)
async def cat(
    accessor: NextcloudAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        # Single file: stream via a cachable returned AS stdout so the tee
        # fills the cache as the consumer reads. Multiple files: a joined
        # stdout is a different object from the per-file cachables, so the
        # cache-fill background drain races the consumer on the same network
        # stream and poisons the cache. Read each file fully to bytes: cache
        # each path's real bytes directly (no drain, no race) and concatenate.
        if len(paths) == 1:
            p = paths[0]
            await stat(accessor, p, index)
            cachable = CachableAsyncIterator(read_stream(accessor, p))
            io = IOResult(reads={p.strip_prefix: cachable},
                          cache=[p.strip_prefix])
            source: ByteSource = cachable
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
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
