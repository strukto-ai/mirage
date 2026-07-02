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
from mirage.utils.errors import enoent
from mirage.utils.path import norm


async def stream(accessor: RAMAccessor,
                 path: PathSpec) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    path = norm(path.resource_path)
    store = accessor.store
    key = norm(path)
    if key not in store.files:
        raise enoent(virtual)
    data = store.files[key]
    rec = record_stream("read", path, "ram")
    if rec is not None:
        rec.bytes = len(data)
    yield data


async def read_stream(accessor: RAMAccessor,
                      path: PathSpec,
                      index: IndexCacheStore = None) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    path = norm(path.resource_path)
    try:
        gen = stream(accessor, path)
        async for chunk in gen:
            yield chunk
    except FileNotFoundError as exc:
        raise enoent(virtual) from exc
