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
from mirage.core.dev.constants import ZERO_CHUNK_SIZE
from mirage.core.dev.device import active_device
from mirage.core.ram.stream import read_stream as ram_read_stream
from mirage.types import PathSpec
from mirage.utils.path import norm


async def read_stream(
    accessor: RAMAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> AsyncIterator[bytes]:
    """Stream a /dev path.

    ``/dev/null`` yields nothing. ``/dev/zero`` yields a fixed zero chunk
    forever and stops the moment the reader stops iterating, so nothing
    is materialized. A recreated real file streams normally.
    """
    device = active_device(accessor, norm(path.mount_path))
    if device is None:
        async for chunk in ram_read_stream(accessor, path, index):
            yield chunk
        return
    if device == "null":
        return
    chunk = b"\x00" * ZERO_CHUNK_SIZE
    while True:
        yield chunk
