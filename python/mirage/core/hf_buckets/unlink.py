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

try:
    from huggingface_hub import HfApi
    from huggingface_hub.errors import (EntryNotFoundError,
                                        RepositoryNotFoundError)
except ImportError:
    HfApi = None
    EntryNotFoundError = RepositoryNotFoundError = Exception

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hf_buckets._client import HfBucketsClient, _key
from mirage.core.hf_buckets.stat import stat
from mirage.observe.context import record
from mirage.resource.secrets import reveal_secret
from mirage.types import FileType, PathSpec

_MISSING_DEP = ("huggingface_hub is required for hf_buckets writes. "
                "Install with: pip install mirage-ai[hf_buckets]")


def _delete_sync(token: str | None, endpoint: str, bucket_id: str,
                 key: str) -> None:
    if HfApi is None:
        raise ImportError(_MISSING_DEP)
    api = HfApi(endpoint=endpoint, token=token)
    api.batch_bucket_files(bucket_id, delete=[key])


async def unlink(accessor: HfBucketsAccessor,
                 path: PathSpec,
                 index: IndexCacheStore | None = None) -> None:
    if isinstance(path, str):
        path = PathSpec.from_str_path(path)
    file_stat = await stat(accessor, path, index)
    if file_stat.type == FileType.DIRECTORY:
        raise IsADirectoryError(path.strip_prefix)
    raw = path.strip_prefix
    config = accessor.config
    key = _key(raw, config)
    client = HfBucketsClient(config)
    bucket_id = await client.bucket_id()
    token = reveal_secret(config.token)
    start_ms = int(time.monotonic() * 1000)
    try:
        await asyncio.to_thread(_delete_sync, token, config.endpoint,
                                bucket_id, key)
    except (RepositoryNotFoundError, EntryNotFoundError) as exc:
        raise FileNotFoundError(raw) from exc
    record("unlink", path.original, "hf_buckets", 0, start_ms)
