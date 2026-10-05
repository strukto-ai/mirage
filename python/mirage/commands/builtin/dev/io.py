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

import dataclasses
from collections.abc import AsyncIterator

from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.ram.io import IO as _RAM_IO
from mirage.core.dev.read import read as _read
from mirage.core.dev.stat import stat as _stat
from mirage.core.dev.stream import read_stream as _read_stream
from mirage.types import PathSpec


async def _finite_stream(
    accessor: RAMAccessor, path: PathSpec, index: IndexCacheStore = NULL_INDEX
) -> AsyncIterator[bytes]:
    data = await _read(accessor, path, index)
    if data:
        yield data


# /dev is a RAM mount whose read and stat know the two synthetic
# character devices; every other slot is RAM's. Commands that consume a
# whole input use the refusing read operation, while the two bounded
# streaming commands opt into the endless source below.
STREAMING_IO = dataclasses.replace(
    _RAM_IO,
    stat=_stat,
    read_bytes=_read,
    read_range=_read,
    read_stream=_read_stream,
)
IO = dataclasses.replace(STREAMING_IO, read_stream=_finite_stream)
