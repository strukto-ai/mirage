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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import stream_item
from mirage.core.onedrive._client import drive_loc, split_path
from mirage.core.onedrive.read import read_bytes
from mirage.types import PathSpec


async def read_stream(
    accessor: OneDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    _, stripped = split_path(path)
    loc = drive_loc(accessor.config, stripped)
    async for chunk in stream_item(accessor.config, loc, virtual, stripped,
                                   "onedrive", chunk_size):
        yield chunk


async def range_read(accessor: OneDriveAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    return await read_bytes(accessor,
                            path,
                            offset=start,
                            size=end - start,
                            index=NULL_INDEX)
