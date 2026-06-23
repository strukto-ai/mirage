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


def _extract_level(extra: dict) -> int:
    for n in range(9, 0, -1):
        if extra.get(str(n)):
            return n
    return zlib.Z_DEFAULT_COMPRESSION


async def _gzip_compress_stream(
    source: AsyncIterator[bytes],
    level: int = zlib.Z_DEFAULT_COMPRESSION,
) -> AsyncIterator[bytes]:
    compressor = zlib.compressobj(level, zlib.DEFLATED, zlib.MAX_WBITS | 16)
    async for chunk in source:
        compressed = compressor.compress(chunk)
        if compressed:
            yield compressed
    tail = compressor.flush()
    if tail:
        yield tail


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


@command("gzip", resource="sharepoint", spec=SPECS["gzip"], write=True)
async def gzip(
    accessor: SharePointAccessor,
    paths: list[PathSpec],
    *texts: str,
    stdin: AsyncIterator[bytes] | bytes | None = None,
    d: bool = False,
    k: bool = False,
    f: bool = False,
    c: bool = False,
    index: IndexCacheStore = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    level = _extract_level(_extra)
    if not paths:
        source = _resolve_source(stdin, "gzip: missing input")
        if d:
            return _gzip_decompress_stream(source), IOResult()
        return _gzip_compress_stream(source, level=level), IOResult()

    paths = await resolve_glob(accessor, paths, index)
    if c:
        chunks: list[bytes] = []
        for p in paths:
            raw = await read_bytes(accessor, p)
            if d:
                chunks.append(zlib.decompress(raw, zlib.MAX_WBITS | 16))
            else:
                chunks.append(
                    zlib.compress(raw, level=level, wbits=zlib.MAX_WBITS | 16))
        return b"".join(chunks), IOResult()

    writes: dict[str, bytes] = {}
    for p in paths:
        raw = await read_bytes(accessor, p)
        p_stripped = p.strip_prefix if isinstance(p, PathSpec) else p
        if d:
            out_path = p_stripped.removesuffix(".gz") if p_stripped.endswith(
                ".gz") else p_stripped + ".out"
            out_data = zlib.decompress(raw, zlib.MAX_WBITS | 16)
        else:
            out_path = p_stripped + ".gz"
            out_data = zlib.compress(raw,
                                     level=level,
                                     wbits=zlib.MAX_WBITS | 16)
        await write_bytes(accessor, out_path, out_data)
        writes[out_path] = out_data
        if not k:
            await unlink(accessor,
                         p.strip_prefix if isinstance(p, PathSpec) else p)
    return None, IOResult(writes=writes)
