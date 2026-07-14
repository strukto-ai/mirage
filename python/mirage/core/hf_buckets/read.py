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

from opendal.exceptions import NotFound

from mirage.accessor.hf_buckets import HfBucketsAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(accessor: HfBucketsAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    raw = path.mount_path
    key = raw.lstrip("/")
    op = accessor.operator()
    start_ms = int(time.monotonic() * 1000)
    try:
        if offset or size is not None:
            async with await op.open(key, "rb") as f:
                if offset:
                    await f.seek(offset)
                data = await f.read(size
                                    ) if size is not None else await f.read()
        else:
            data = bytes(await op.read(key))
    except NotFound as exc:
        raise enoent(path) from exc
    record("read", raw, accessor.RESOURCE_NAME, len(data), start_ms)
    return data
