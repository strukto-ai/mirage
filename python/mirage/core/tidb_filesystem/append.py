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

from mirage.accessor.tidb_filesystem import TiDBFilesystemAccessor
from mirage.core.generic.rewrite import append_by_streamed_rewrite
from mirage.core.tidb_filesystem.client import append_to
from mirage.core.tidb_filesystem.path import backend_path
from mirage.core.tidb_filesystem.stat import stat
from mirage.core.tidb_filesystem.stream import read_stream
from mirage.core.tidb_filesystem.write import write
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def append(
    accessor: TiDBFilesystemAccessor, path: PathSpec, data: ByteSource
) -> None:
    """Add bytes to the end of a file.

    A file drive9 keeps in object storage takes them natively, so only
    its last part and the new bytes move. Any other path is read and
    written back whole, which makes a missing file and refuses a
    directory.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the file.
        data (ByteSource): the bytes to add, consumed once.
    """
    async with ByteSpool() as spool:
        await spool.fill(data)
        timer = start_op()
        remote = backend_path(accessor.config, path)
        if spool.size and await append_to(accessor, remote, spool):
            record(
                "append", path.virtual, "tidb_filesystem", spool.size, timer
            )
            return
        await append_by_streamed_rewrite(
            lambda p, remember: read_stream(accessor, p),
            lambda p, body: write(accessor, p, body),
            lambda p: stat(accessor, p),
            path,
            spool.stream(),
        )
