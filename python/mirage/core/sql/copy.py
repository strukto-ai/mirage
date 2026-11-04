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
from mirage.core.sql.constants import FILE
from mirage.core.sql.inode import (
    by_entry,
    by_ino,
    is_dir,
    make_node,
    now_stamp,
    resized,
)
from mirage.core.sql.path import (
    check_dest_parents,
    found,
    leaf,
    parent_ref,
    target,
    walk,
)
from mirage.errors.fs import eisdir
from mirage.types import PathSpec
from mirage.vfs.sql.types import SqlStatement


async def copy(accessor: SqlAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Copy a file's bytes to ``dst`` inside the database, row for row:
    nothing passes through the mount. Mirrors TypeScript's ``copy``."""
    frm = walk(accessor, src)
    to = walk(accessor, dst)
    check_dest_parents(to, dst)
    node = found(frm, src)
    if is_dir(node):
        raise eisdir(src)
    there = target(to)
    if there is not None and is_dir(there):
        raise eisdir(dst)
    if there is not None and there.ino == node.ino:
        return
    now = now_stamp()
    ino = (
        by_ino(there.ino)
        if there is not None
        else by_entry(parent_ref(to), leaf(to))
    )
    statements: list[SqlStatement] = (
        [
            SqlStatement(f"DELETE FROM fs_data WHERE ino = {ino.sql}"),
            resized(ino, node.size, now),
        ]
        if there is not None
        else make_node(
            accessor, parent_ref(to), leaf(to), FILE, node.size, now
        )
    )
    statements.append(
        SqlStatement(
            "INSERT INTO fs_data (ino, chunk_index, data)"
            f" SELECT {ino.sql}, chunk_index, data FROM fs_data"
            f" WHERE ino = {by_ino(node.ino).sql}",
            ino.params,
        )
    )
    accessor.batch(statements)
