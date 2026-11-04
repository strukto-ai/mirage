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

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.data import read_bytes
from mirage.core.sql.inode import is_dir
from mirage.core.sql.path import found, walk
from mirage.errors.fs import eisdir
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName


async def read(
    accessor: SqlAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    """Read a file, optionally only a byte range of it.

    Args:
        accessor (SqlAccessor): the database.
        path (PathSpec): the path to read.
        offset (int): where the window starts.
        size (int | None): the window's length; None to the end.
    """
    timer = start_op()
    node = found(walk(accessor, path), path)
    if is_dir(node):
        raise eisdir(path)
    data = read_bytes(accessor, node, offset, size)
    record("read", path.virtual, VFSName.SQL, len(data), timer)
    return data
