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

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets._client import HfBucketsClient, _key, _resolve_url
from mirage.core.hf_buckets.constants import DEFAULT_CHUNK_SIZE
from mirage.observe.context import record, record_stream
from mirage.types import PathSpec


async def range_read(accessor: HfBucketsAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    config = accessor.config
    key = _key(raw, config)
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    url = _resolve_url(config.endpoint, bucket_id, key)
    headers = {"Range": f"bytes={start}-{end - 1}"}
    start_ms = int(time.monotonic() * 1000)
    async with await client.session() as session:
        async with session.get(url, headers=headers,
                               allow_redirects=True) as resp:
            if resp.status == 404:
                raise FileNotFoundError(raw)
            if resp.status != 200 and resp.status != 206:
                resp.raise_for_status()
                raise FileNotFoundError(raw)
            data = await resp.read()
            record("read",
                   raw,
                   "hf_buckets",
                   len(data),
                   start_ms,
                   fingerprint=resp.headers.get("X-Xet-Hash"))
            return data


async def read_stream(
    accessor: HfBucketsAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    config = accessor.config
    key = _key(raw, config)
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    url = _resolve_url(config.endpoint, bucket_id, key)
    rec = record_stream("read", raw, "hf_buckets")
    async with await client.session() as session:
        async with session.get(url, allow_redirects=True) as resp:
            if resp.status == 404:
                raise FileNotFoundError(raw)
            if resp.status != 200 and resp.status != 206:
                resp.raise_for_status()
                raise FileNotFoundError(raw)
            if rec is not None:
                rec.fingerprint = resp.headers.get("X-Xet-Hash")
            async for chunk in resp.content.iter_chunked(chunk_size):
                if rec is not None:
                    rec.bytes += len(chunk)
                yield chunk
