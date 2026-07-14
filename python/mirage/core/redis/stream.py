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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.path import norm


async def stream(accessor: RedisAccessor,
                 path: PathSpec) -> AsyncIterator[bytes]:
    virtual = path.virtual
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.virtual
    if prefix and raw.startswith(prefix):
        rest = raw[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            raw = rest or "/"
    store = accessor.store
    key = norm(raw)
    data = await store.get_file(key)
    if data is None:
        raise enoent(virtual)
    rec = record_stream("read", raw, "redis")
    if rec is not None:
        rec.bytes = len(data)
    yield data


async def read_stream(
    accessor: RedisAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    try:
        async for chunk in stream(accessor, path):
            yield chunk
    except FileNotFoundError as exc:
        raise enoent(path.virtual) from exc
