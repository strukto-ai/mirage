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

import functools
from collections.abc import AsyncIterator
from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.builtin.generic_bind import generic_commands
from mirage.commands.config import CommandIO
from mirage.core.dev.constants import ZERO_CHUNK_SIZE
from mirage.types import PathSpec
from mirage.vfs.types import ReadRangeOp


async def _ranged(
    read_range: ReadRangeOp,
    accessor: Accessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> AsyncIterator[bytes]:
    """Stream ``path`` as successive ranged reads at the dispatcher.

    ``/dev/zero`` answers every range in full, so the stream ends only
    when the reader stops; ``/dev/null`` and a regular file end at the
    first short range. Each range is a dispatcher read, so hides, path rules
    and policies judge it.

    Args:
        read_range (ReadRangeOp): the table's ranged read.
        accessor (Accessor): backend handle.
        path (PathSpec): the file.
        index (IndexCacheStore): the mount's index.
    """
    offset = 0
    while True:
        chunk = await read_range(
            accessor, path, index, offset, ZERO_CHUNK_SIZE
        )
        if chunk:
            yield chunk
        if len(chunk) < ZERO_CHUNK_SIZE:
            return
        offset += len(chunk)


def _endless(io: CommandIO) -> CommandIO:
    if io.read_range is None:
        return io
    return replace(io, read_stream=functools.partial(_ranged, io.read_range))


# /dev is a RAM mount whose read and stat know the two synthetic
# character devices. Commands that consume a whole input read a finite
# stream, while the two bounded streaming commands read in ranges, which
# /dev/zero answers without end.
COMMANDS = [
    *generic_commands(
        "ram",
        adapt={"cat": _endless, "head": _endless},
        local=True,
    ),
]
