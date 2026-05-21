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

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import IndexCacheStore
from mirage.observe.context import record_stream
from mirage.types import PathSpec


def _norm(path: str) -> str:
    return "/" + path.strip("/")


async def stream(accessor: RAMAccessor,
                 path: PathSpec) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
        if prefix and path.startswith(prefix):
            rest = path[len(prefix):]
            if prefix.endswith("/") or rest == "" or rest.startswith("/"):
                path = rest or "/"
    store = accessor.store
    key = _norm(path)
    if key not in store.files:
        raise FileNotFoundError(path)
    data = store.files[key]
    rec = record_stream("read", path, "ram")
    if rec is not None:
        rec.bytes = len(data)
    yield data


async def read_stream(accessor: RAMAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = None) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"
    async for chunk in stream(accessor, path):
        yield chunk
