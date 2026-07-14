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

import time
from collections.abc import AsyncIterator

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets.constants import DEFAULT_CHUNK_SIZE
from mirage.observe.context import record, record_stream
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def range_read(accessor: HfBucketsAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        async with await op.open(key, "rb") as f:
            if start:
                await f.seek(start)
            data = await f.read(end - start)
    except NotFound as exc:
        raise enoent(path) from exc
    record("read", raw, accessor.RESOURCE_NAME, len(data), start_ms)
    return data


async def read_stream(
    accessor: HfBucketsAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    rec = record_stream("read", raw, accessor.RESOURCE_NAME)
    try:
        async with await op.open(key, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                chunk_bytes = bytes(chunk)
                if rec is not None:
                    rec.bytes += len(chunk_bytes)
                yield chunk_bytes
    except NotFound as exc:
        raise enoent(path) from exc
