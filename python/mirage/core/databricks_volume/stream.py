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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume.read import read_bytes
from mirage.observe.context import record_stream
from mirage.types import PathSpec


async def read_stream(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    rec = record_stream("read", path.original, "databricks_volume")
    offset = 0
    while True:
        chunk = await read_bytes(accessor, path, index, offset, chunk_size)
        if not chunk:
            return
        if rec is not None:
            rec.bytes += len(chunk)
        yield chunk
        if len(chunk) < chunk_size:
            return
        offset += chunk_size


async def range_read(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    start: int,
    end: int,
) -> bytes:
    return await read_bytes(accessor, path, offset=start, size=end - start)
