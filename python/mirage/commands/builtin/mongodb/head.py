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

from mirage.accessor.mongodb import MongoDBAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.mongodb._provision import file_read_provision
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.mongodb.glob import resolve_glob
from mirage.core.mongodb.stream import read_stream
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.provision.types import ProvisionResult
from mirage.types import PathSpec


async def head_provision(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    **_extra: object,
) -> ProvisionResult:
    return await file_read_provision(
        accessor, paths,
        "head " + " ".join(p.original if isinstance(p, PathSpec) else p
                           for p in paths))


async def _head_stream(source: AsyncIterator[bytes], lines: int,
                       bytes_mode: int | None) -> AsyncIterator[bytes]:
    if bytes_mode is not None:
        total = 0
        async for chunk in source:
            remaining = bytes_mode - total
            if remaining <= 0:
                return
            if len(chunk) <= remaining:
                yield chunk
                total += len(chunk)
            else:
                yield chunk[:remaining]
                return
        return
    line_iter = AsyncLineIterator(source)
    count = 0
    async for line in line_iter:
        if count >= lines:
            return
        yield line + b"\n"
        count += 1


async def _head_bytes_static(data: bytes, lines: int,
                             bytes_mode: int | None) -> AsyncIterator[bytes]:
    if bytes_mode is not None:
        yield data[:bytes_mode]
        return
    parts = data.split(b"\n", lines)
    yield b"\n".join(parts[:lines])


@command("head",
         resource="mongodb",
         spec=SPECS["head"],
         provision=head_provision)
async def head(
    accessor: MongoDBAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    n: str | None = None,
    c: str | None = None,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    lines = int(n) if n is not None else 10
    bytes_mode = int(c) if c is not None else None
    if paths:
        paths = await resolve_glob(accessor, paths, index=index)
        p = paths[0]
        source = read_stream(accessor, p, index)
        return _head_stream(source, lines, bytes_mode), IOResult()
    raw = await _read_stdin_async(stdin)
    if raw is None:
        raise ValueError("head: missing operand")
    return _head_bytes_static(raw, lines, bytes_mode), IOResult()
