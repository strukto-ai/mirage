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
from mirage.core.sql.inode import by_ino, drop_inodes, is_dir
from mirage.core.sql.path import found, leaf, parent_of, walk
from mirage.errors.fs import ebusy, enotdir, enotempty
from mirage.types import PathSpec
from mirage.vfs.sql.types import SqlStatement


async def rmdir(accessor: SqlAccessor, path: PathSpec) -> None:
    """Remove an empty directory. The entry goes only while the
    directory holds nothing, checked in the statement that removes it,
    so a child written since the check keeps it there and the call
    answers ENOTEMPTY. Mirrors TypeScript's ``rmdir``."""
    w = await walk(accessor, path)
    node = found(w, path)
    if not is_dir(node):
        raise enotdir(path)
    parent = parent_of(w)
    if parent is None:
        raise ebusy(path)
    if await accessor.query(SQL["has_child"], (node.ino,)):
        raise enotempty(path)
    await accessor.batch(
        [
            SqlStatement(
                f"{SQL['remove_entry']} AND NOT EXISTS (\n"
                "        SELECT 1 FROM fs_dentry c WHERE c.parent_ino ="
                f" {by_ino(node.ino).sql})",
                (parent.ino, leaf(w)),
            ),
            *drop_inodes([node.ino]),
        ]
    )
    if await accessor.query(SQL["has_entry"], (parent.ino, leaf(w))):
        raise enotempty(path)
