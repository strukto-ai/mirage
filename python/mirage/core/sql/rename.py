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
from mirage.core.sql.path import (
    check_dest_parents,
    found,
    leaf,
    parent_of,
    target,
    walk,
)
from mirage.errors.fs import ebusy, einval, eisdir, enotdir, enotempty
from mirage.types import PathSpec
from mirage.vfs.sql.types import SqlStatement


async def rename(accessor: SqlAccessor, src: PathSpec, dst: PathSpec) -> None:
    """Move an entry, as rename(2) does: one entry changes its parent and
    name, so a directory carries everything under it, and the move lands
    in one transaction. A file onto a directory is EISDIR, a directory
    onto a file ENOTDIR, onto a directory that holds entries ENOTEMPTY,
    and into its own subtree EINVAL; a file or empty directory at the
    destination is replaced. A directory there goes only while it is
    still empty: one another writer wrote into since the check keeps its
    entry, the move meets that name and fails whole, and the call answers
    ENOTEMPTY. Mirrors TypeScript's ``rename``."""
    frm = await walk(accessor, src)
    to = await walk(accessor, dst)
    check_dest_parents(to, dst)
    node = found(frm, src)
    if frm.p == to.p:
        return
    from_parent = parent_of(frm)
    to_parent = parent_of(to)
    if from_parent is None:
        raise ebusy(src)
    if to_parent is None:
        raise ebusy(dst)
    there = target(to)
    if is_dir(node):
        if any(n is not None and n.ino == node.ino for n in to.chain):
            raise einval(src)
        if there is not None and not is_dir(there):
            raise enotdir(dst)
        if there is not None and await accessor.query(
            SQL["has_child"], (there.ino,)
        ):
            raise enotempty(dst)
    elif there is not None and is_dir(there):
        raise eisdir(dst)
    statements: list[SqlStatement] = []
    if there is not None:
        empty = (
            " AND NOT EXISTS (SELECT 1 FROM fs_dentry c"
            f" WHERE c.parent_ino = {by_ino(there.ino).sql})"
            if is_dir(there)
            else ""
        )
        statements.append(
            SqlStatement(
                SQL["remove_entry"] + empty, (to_parent.ino, leaf(to))
            )
        )
    statements.append(
        SqlStatement(
            SQL["move_entry"],
            (to_parent.ino, leaf(to), from_parent.ino, leaf(frm)),
        )
    )
    if there is not None:
        statements += drop_inodes([there.ino])
    try:
        await accessor.batch(statements)
    except Exception:
        if (
            there is not None
            and is_dir(there)
            and await accessor.query(SQL["has_child"], (there.ino,))
        ):
            raise enotempty(dst) from None
        raise
