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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.gdrive._provision import file_read_provision
from mirage.commands.builtin.generic.cat import cat as generic_cat
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.gdrive.glob import resolve_glob
from mirage.core.gdrive.stream import read_stream as gdrive_read_stream
from mirage.io.cachable_iterator import CachableAsyncIterator
from mirage.io.stream import async_chain
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def cat_provision(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor,
        paths,
        "cat " + " ".join(p.original if isinstance(p, PathSpec) else p
                          for p in paths),
        index=index)


@command("cat", resource="gdrive", spec=SPECS["cat"], provision=cat_provision)
async def cat(
    accessor: GDriveAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: bool = False,
    index: IndexCacheStore = None,
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
            result = await gdrive_read_stream(accessor, p, index)
            value: ByteSource = (result if isinstance(result, bytes) else
                                 CachableAsyncIterator(result))
            io = IOResult(reads={p.strip_prefix: value},
                          cache=[p.strip_prefix])
            source: ByteSource = value
        else:
            reads: dict[str, ByteSource] = {}
            parts: list[bytes] = []
            for p in paths:
                result = await gdrive_read_stream(accessor, p, index)
                data = (result if isinstance(result, bytes) else b"".join(
                    [chunk async for chunk in result]))
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
