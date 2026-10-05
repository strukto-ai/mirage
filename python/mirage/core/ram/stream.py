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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ram.dest import lookup_error
from mirage.observe.context import record_stream
from mirage.types import PathSpec
from mirage.utils.errors import eisdir
from mirage.utils.path import norm


async def read_stream(
    accessor: RAMAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    virtual = path_spec.virtual
    path = norm(path_spec.vfs_path)
    store = accessor.store
    key = norm(path)
    if key not in store.files:
        if key in store.dirs:
            raise eisdir(path_spec)
        raise lookup_error(store, path_spec, key)
    data = store.files[key]
    rec = record_stream("read", virtual, "ram")
    if rec is not None:
        rec.bytes = len(data)
    yield data
