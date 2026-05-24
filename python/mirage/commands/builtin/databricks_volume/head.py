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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.databricks_volume.glob import resolve_glob
from mirage.core.databricks_volume.stream import range_read, read_stream
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _head_stream(
    source: AsyncIterator[bytes],
    lines: int = 10,
    bytes_mode: int | None = None,
) -> AsyncIterator[bytes]:
    if bytes_mode is not None:
        remaining = bytes_mode
        async for chunk in source:
            if len(chunk) <= remaining:
                yield chunk
                remaining -= len(chunk)
                if remaining <= 0:
                    return
            else:
                yield chunk[:remaining]
                return
        return
    count = 0
    async for line in AsyncLineIterator(source):
        yield line + b"\n"
        count += 1
        if count >= lines:
            return


async def _single_chunk_stream(data: bytes) -> AsyncIterator[bytes]:
    if data:
        yield data


@command("head", resource="databricks_volume", spec=SPECS["head"])
async def head(
    accessor: DatabricksVolumeAccessor,
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
        paths = await resolve_glob(accessor, paths, index)
        if bytes_mode is not None:
            data = await range_read(accessor, paths[0], 0, bytes_mode)
            return _single_chunk_stream(data), IOResult()
        source = read_stream(accessor, paths[0], index)
        return _head_stream(source, lines, bytes_mode), IOResult()
    source = _resolve_source(stdin, "head: missing operand")
    return _head_stream(source, lines, bytes_mode), IOResult()
