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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.mongodb._provision import file_read_provision
from mirage.commands.builtin.mongodb.io import resolve_glob
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.read import read as mongodb_read
from mirage.core.mongodb.scope import detect_scope
from mirage.core.mongodb.stream import read_stream
from mirage.core.mongodb.types import ScopeLevel
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


@command("cat",
         resource="mongodb",
         spec=SPECS["cat"],
         provision=file_read_provision)
async def cat(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: ByteSource | None = None,
    n: bool = False,
    index: IndexCacheStore,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if paths:
        paths = await resolve_glob(accessor, paths, index)
        # Single file: return the read result directly (bytes) or a cachable
        # tee returned AS stdout so the cache fills as the consumer reads.
        # Multiple files: a joined stdout is a different object from the
        # per-file cachables, so the cache-fill background drain races the
        # consumer on the same network stream and poisons the cache. Read each
        # file fully to bytes: cache real bytes directly and concatenate.
        if len(paths) == 1:
            p = paths[0]
            scope = detect_scope(p)
            if scope.level == ScopeLevel.DOCUMENTS:
                value: ByteSource = CachableAsyncIterator(
                    read_stream(accessor, p, index))
            else:
                value = await mongodb_read(accessor, p, index)
            io = IOResult(reads={p.mount_path: value}, cache=[p.mount_path])
            source: ByteSource = value
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                scope = detect_scope(p)
                if scope.level == ScopeLevel.DOCUMENTS:
                    data = b"".join([
                        chunk
                        async for chunk in read_stream(accessor, p, index)
                    ])
                else:
                    data = await mongodb_read(accessor, p, index)
                reads[p.mount_path] = data
                parts.append(data)
            io = IOResult(reads=reads, cache=list(reads))
            source = async_chain(*parts)
        return (generic_cat(source, number_lines=True) if n else source), io
    source = _resolve_source(stdin, "cat: missing operand")
    return (generic_cat(source, number_lines=True)
            if n else source), IOResult()
