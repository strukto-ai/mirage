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

import zlib
from collections.abc import AsyncIterator

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.utils.stream import _resolve_source
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.core.sharepoint.glob import resolve_glob
from mirage.core.sharepoint.read import read_bytes
from mirage.core.sharepoint.unlink import unlink
from mirage.core.sharepoint.write import write_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


async def _gzip_decompress_stream(
        source: AsyncIterator[bytes]) -> AsyncIterator[bytes]:
    decompressor = zlib.decompressobj(zlib.MAX_WBITS | 16)
    async for chunk in source:
        decompressed = decompressor.decompress(chunk)
        if decompressed:
            yield decompressed
    tail = decompressor.flush()
    if tail:
        yield tail


@command("gunzip", resource="sharepoint", spec=SPECS["gunzip"], write=True)
async def gunzip(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    k: bool = False,
    f: bool = False,
    c: bool = False,
    t: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not paths:
        source = _resolve_source(stdin, "gunzip: missing input")
        return _gzip_decompress_stream(source), IOResult()

    paths = await resolve_glob(accessor, paths, index)
    if t:
        for p in paths:
            raw = await read_bytes(accessor, p)
            zlib.decompress(raw, zlib.MAX_WBITS | 16)
        return None, IOResult()

    if c:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(accessor, p)
            chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, bytes] = {}
    for p in paths:
        raw = await read_bytes(accessor, p)
        p_str = p.strip_prefix
        out_path = p_str.removesuffix(".gz") if p_str.endswith(
            ".gz") else p_str + ".out"
        out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        await write_bytes(accessor, out_path, out_data)
        writes[out_path] = out_data
        if not k:
            await unlink(accessor, p)
    return None, IOResult(writes=writes)
