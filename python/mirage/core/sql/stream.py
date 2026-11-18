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

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import FLUSH_BYTES, READ_BYTES
from mirage.core.sql.data import read_bytes
from mirage.core.sql.inode import is_dir
from mirage.core.sql.path import found, walk
from mirage.errors.fs import eisdir
from mirage.io.memory import memory_room
from mirage.observe.context import record_stream
from mirage.types import PathSpec, VFSName


async def read_stream(
    accessor: SqlAccessor,
    path: PathSpec,
) -> AsyncIterator[bytes]:
    """Stream smaller pages on tight heaps and amortize remote SQL calls
    on larger ones."""
    node = found(await walk(accessor, path), path)
    if is_dir(node):
        raise eisdir(path)
    rec = record_stream("read", path.virtual, VFSName.SQL)
    room = memory_room()
    window = (
        READ_BYTES
        if room is not None and room <= 32 * FLUSH_BYTES
        else FLUSH_BYTES
    )
    cs = await accessor.chunk_size()
    offset = 0
    while offset < node.size:
        length = min(window, cs - offset % cs) if cs > window else window
        data = await read_bytes(accessor, node, offset, length)
        offset += len(data)
        if rec is not None:
            rec.bytes += len(data)
        yield data
    if rec is not None:
        rec.complete = True
