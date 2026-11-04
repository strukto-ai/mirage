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
from mirage.core.sql.inode import by_ino, drop_inodes, inode_of, is_dir
from mirage.core.sql.path import leaf, parent_of, target, walk
from mirage.errors.fs import enotempty
from mirage.types import PathSpec
from mirage.vfs.sql.types import SqlStatement


async def rm_r(accessor: SqlAccessor, path: PathSpec) -> None:
    """Remove a path and everything under it, in one transaction.

    The tree is listed first, so an entry written under it meanwhile is
    not on the list: a directory goes only once it holds nothing,
    deepest first, and one such an entry keeps is left standing with the
    directories above it, and the call answers ENOTEMPTY. Mirrors
    TypeScript's ``rmR``.
    """
    w = await walk(accessor, path)
    node = target(w)
    if node is None:
        return
    parent = parent_of(w)
    statements: list[SqlStatement] = []
    inos: list[int] = []
    if is_dir(node):
        files: list[int] = []
        dirs: dict[int, list[int]] = {}
        for row in await accessor.query(SQL["subtree"], (node.ino,)):
            child = inode_of(row)
            if child is None:
                continue
            inos.append(child.ino)
            if not is_dir(child):
                files.append(int(row["id"] or 0))
            else:
                dirs.setdefault(int(row["depth"] or 0), []).append(
                    int(row["id"] or 0)
                )
        for i in range(0, len(files), 500):
            ids = ", ".join(str(n) for n in files[i : i + 500])
            statements.append(
                SqlStatement(f"DELETE FROM fs_dentry WHERE id IN ({ids})")
            )
        for depth in sorted(dirs, reverse=True):
            ids = ", ".join(str(n) for n in dirs[depth])
            statements.append(
                SqlStatement(
                    f"DELETE FROM fs_dentry WHERE id IN ({ids})"
                    " AND NOT EXISTS (SELECT 1 FROM fs_dentry c"
                    " WHERE c.parent_ino = fs_dentry.ino)"
                )
            )
    if parent is not None:
        statements.append(
            SqlStatement(
                f"{SQL['remove_entry']} AND NOT EXISTS (\n"
                "        SELECT 1 FROM fs_dentry c WHERE c.parent_ino ="
                f" {by_ino(node.ino).sql})",
                (parent.ino, leaf(w)),
            )
        )
        inos.append(node.ino)
    await accessor.batch([*statements, *drop_inodes(inos)])
    if parent is not None and await accessor.query(
        SQL["has_entry"], (parent.ino, leaf(w))
    ):
        raise enotempty(path)
