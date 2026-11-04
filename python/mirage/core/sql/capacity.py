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
from mirage.core.sql.constants import SQL
from mirage.core.sql.inode import inode_of, is_dir, is_file
from mirage.core.sql.path import target, walk
from mirage.types import PathSpec


async def size_of(accessor: SqlAccessor, path: PathSpec) -> int:
    """The bytes at ``path``, a directory's files included; 0 for none.
    Mirrors TypeScript's ``sizeOf``."""
    node = target(await walk(accessor, path))
    if node is None:
        return 0
    if not is_dir(node):
        return node.size
    total = 0
    for row in await accessor.query(SQL["subtree"], (node.ino,)):
        child = inode_of(row)
        if child is not None and is_file(child):
            total += child.size
    return total


async def count(accessor: SqlAccessor) -> int:
    """The bytes every file of the database holds. Mirrors TypeScript's
    ``count``."""
    rows = await accessor.query(SQL["used_bytes"])
    return int(rows[0]["n"] or 0) if rows else 0
