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

import asyncio
import time

from huggingface_hub.errors import EntryNotFoundError, RepositoryNotFoundError

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets._client import HfBucketsClient, _key
from mirage.observe.context import record
from mirage.resource.secrets import reveal_secret
from mirage.types import PathSpec


def _upload_sync(token: str | None, endpoint: str, bucket_id: str, key: str,
                 data: bytes) -> None:
    # Lazy import: huggingface_hub is an optional [hf_buckets] extra.
    from huggingface_hub import HfApi
    api = HfApi(endpoint=endpoint, token=token)
    api.batch_bucket_files(bucket_id, add=[(data, key)])


async def write_bytes(accessor: HfBucketsAccessor,
                      path: PathSpec,
                      data: bytes,
                      index: IndexCacheStore | None = None) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    raw = path.strip_prefix
    config = accessor.config
    key = _key(raw, config)
    client = HfBucketsClient(config)
    try:
        bucket_id = await client.bucket_id()
    except Exception as exc:
        raise FileNotFoundError(raw) from exc
    token = reveal_secret(config.token)
    start_ms = int(time.monotonic() * 1000)
    try:
        await asyncio.to_thread(_upload_sync, token, config.endpoint,
                                bucket_id, key, data)
    except (RepositoryNotFoundError, EntryNotFoundError) as exc:
        raise FileNotFoundError(raw) from exc
    record("write", path.original, "hf_buckets", len(data), start_ms)
