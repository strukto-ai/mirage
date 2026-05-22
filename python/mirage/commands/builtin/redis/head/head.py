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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.aggregators import header_aggregate
from mirage.commands.builtin.generic.head import head as generic_head
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.redis.glob import resolve_glob
from mirage.core.redis.stat import stat as _stat_async
from mirage.core.redis.stream import stream as _stream_core
from mirage.io.types import ByteSource, IOResult
from mirage.provision import Precision, ProvisionResult
from mirage.types import PathSpec


async def head_provision(
    accessor: RedisAccessor = None,
    paths: list[PathSpec] | None = None,
    *texts: str,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> ProvisionResult:
    if not paths or accessor.store is None:
        return ProvisionResult(command="head")
    paths = await resolve_glob(accessor, paths, index)
    s = await _stat_async(accessor, paths[0])
    file_size = s.size
    lines = int(n) if n is not None else 10
    avg_line = 80
    low = min(lines * avg_line, file_size)
    return ProvisionResult(
        command=f"head {paths[0].original}",
        network_read_low=low,
        network_read_high=file_size,
        read_ops=1,
        precision=Precision.RANGE,
    )


async def _head_multi(
    accessor: RedisAccessor,
    paths: list[PathSpec],
    n: int | None,
    c: int | None,
) -> AsyncIterator[bytes]:
    for i, p in enumerate(paths):
        if len(paths) > 1:
            header = f"==> {p.original} <==\n"
            if i > 0:
                header = "\n" + header
            yield header.encode()
        source = _stream_core(accessor, p)
        async for chunk in generic_head(source, n=n, c=c):
            yield chunk


@command("head",
         resource="redis",
         spec=SPECS["head"],
         provision=head_provision,
         aggregate=header_aggregate)
async def head(
    accessor: RedisAccessor,
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
    if paths and accessor.store is not None:
        paths = await resolve_glob(accessor, paths, index)
        return _head_multi(accessor, paths, n_int, c_int), IOResult()
    source = _resolve_source(stdin, "head: missing operand")
    return generic_head(source, n=n_int, c=c_int), IOResult()
