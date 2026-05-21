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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record
from mirage.types import PathSpec


def _norm(path: str) -> str:
    return "/" + path.strip("/")


async def read_bytes(accessor: RAMAccessor, path: PathSpec) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        path = path.strip_prefix
    store = accessor.store
    start_ms = int(time.monotonic() * 1000)
    key = _norm(path)
    if key not in store.files:
        raise FileNotFoundError(path)
    data = store.files[key]
    record("read", path, "ram", len(data), start_ms)
    return data


async def read(accessor: RAMAccessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    return await read_bytes(accessor, path)
