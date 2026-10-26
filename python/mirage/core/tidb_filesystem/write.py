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
from mirage.core.tidb_filesystem.client import upload
from mirage.core.tidb_filesystem.dest import check_write_target, kinds_of
from mirage.core.tidb_filesystem.path import backend_path
from mirage.io.spool import ByteSpool
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.path import ancestors, norm


async def write(
    accessor: TiDBFilesystemAccessor,
    path: PathSpec,
    data: ByteSource | ByteSpool,
) -> None:
    """Replace a file's bytes once one fs:batch-stat has found its parent
    chain all directories and the path itself no directory, since drive9
    would make the parents and file the bytes beside a directory. A
    stream is spooled first, as a multipart upload states its size.

    Args:
        accessor (TiDBFilesystemAccessor): the file system's accessor.
        path (PathSpec): the file.
        data (ByteSource | ByteSpool): its new content.

    Raises:
        FileNotFoundError: a folder above the file is missing.
        NotADirectoryError: a component above the file is a file.
        IsADirectoryError: the path is a directory.
    """
    if not isinstance(data, (bytes, ByteSpool)):
        async with ByteSpool() as spool:
            await spool.fill(data)
            await write(accessor, path, spool)
        return
    key = norm(path.mount_path)
    timer = start_op()
    kinds = await kinds_of(accessor, [*ancestors(key), key])
    check_write_target(kinds, path, key)
    await upload(accessor, backend_path(accessor.config, path), data)
    size = data.size if isinstance(data, ByteSpool) else len(data)
    record("write", path.virtual, "tidb_filesystem", size, timer)
