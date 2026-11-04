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
from mirage.core.sql.inode import by_ino, make_node, now_stamp, resized
from mirage.core.sql.path import (
    check_dest_parents,
    check_write_target,
    leaf,
    parent_ref,
    target,
    walk,
)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName
from mirage.utils.stat_view import FILE_MODE
from mirage.vfs.sql.types import SqlStatement


async def create(accessor: SqlAccessor, path: PathSpec) -> None:
    """Make an empty file, or empty the one there. Mirrors TypeScript's
    ``create``."""
    timer = start_op()
    w = walk(accessor, path)
    check_dest_parents(w, path)
    check_write_target(w, path)
    node = target(w)
    now = now_stamp()
    if node is None:
        accessor.batch(
            make_node(accessor, parent_ref(w), leaf(w), FILE_MODE, 0, now)
        )
    else:
        ino = by_ino(node.ino)
        accessor.batch(
            [
                SqlStatement(f"DELETE FROM fs_data WHERE ino = {ino.sql}"),
                resized(ino, 0, now),
            ]
        )
    record("create", path.virtual, VFSName.SQL, 0, timer)
