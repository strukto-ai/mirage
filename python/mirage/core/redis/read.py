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

from mirage.accessor.redis import RedisAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.path import norm


async def read_bytes(accessor: RedisAccessor, path: PathSpec) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    store = accessor.store
    start_ms = int(time.monotonic() * 1000)
    key = norm(path)
    data = await store.get_file(key)
    if data is None:
        raise enoent(virtual)
    record("read", path, "redis", len(data), start_ms)
    return data


async def read(
    accessor: RedisAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    virtual = path.original if isinstance(path, PathSpec) else path
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    try:
        return await read_bytes(accessor, path)
    except FileNotFoundError as exc:
        raise enoent(virtual) from exc
