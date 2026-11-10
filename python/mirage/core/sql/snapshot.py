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

import itertools
from typing import TypedDict

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import (
    CLEAR,
    DIR,
    FILE,
    RENUMBERED,
    RESTORED_INO,
    ROOT_INO,
    SQL,
    clear_under,
)
from mirage.core.sql.data import fill_bytes
from mirage.core.sql.inode import (
    InoRef,
    by_ino,
    inode_of,
    insert_rows,
    is_dir,
    is_file,
    iso_of,
    now_stamp,
    stamp_of,
)
from mirage.utils.path import gnu_basename, parent
from mirage.vfs.sql.types import SqlStatement


class SqlSnapshot(TypedDict):
    """What a snapshot keeps of a sql mount: each file's bytes and each
    directory, by mount path, with the mtime of each. Mirrors
    TypeScript's ``SqlSnapshot``."""

    files: dict[str, bytes]
    dirs: list[str]
    modified: dict[str, str]


def depth(p: str) -> int:
    return p.count("/")


def snapshot(accessor: SqlAccessor) -> SqlSnapshot:
    """Every file and directory of the mount's folder, read in one walk
    of the tree. Blocking, as ``get_state`` is: it calls the driver
    itself. Mirrors TypeScript's ``snapshot``."""
    cs = accessor.ready()
    files: dict[str, bytes] = {}
    dirs = ["/"]
    modified: dict[str, str] = {}
    for row in accessor.driver.query(SQL["subtree"], (accessor.root_ino(),)):
        node = inode_of(row)
        if node is None or not (is_dir(node) or is_file(node)):
            continue
        p = "/" + str(row["rel"])
        if is_dir(node):
            dirs.append(p)
        else:
            rows = accessor.driver.query(
                SQL["chunks"], (node.ino, 0, max(node.size - 1, 0) // cs)
            )
            files[p] = fill_bytes(rows, cs, 0, node.size)
        modified[p] = iso_of(node.mtime, node.mtime_nsec)
    return SqlSnapshot(files=files, dirs=sorted(dirs), modified=modified)


def restore(
    accessor: SqlAccessor,
    *,
    files: dict[str, bytes],
    dirs: list[str],
    modified: dict[str, str],
) -> None:
    """Replace everything the mount's folder holds with a snapshot, in
    one transaction: the directories outermost first, then each file
    under its directory. A path whose directory the snapshot does not
    hold is dropped. The inodes take fresh numbers counted from one the
    database gives first, so an entry names its parent by number however
    deep the tree, and an op that read an inode before the restore
    reaches none it made. Outside the folder, the database keeps what it
    holds. Blocking, as ``load_state`` is. Mirrors TypeScript's
    ``restore``."""
    cs = accessor.ready()
    now = now_stamp()
    root = accessor.root_ino()
    statements = [
        SqlStatement(SQL["drop_base"]),
        SqlStatement(SQL["new_inode"], (FILE, 0, *now)),
        SqlStatement(SQL["set_base"]),
        *(
            SqlStatement(sql)
            for sql in (CLEAR if root == ROOT_INO else clear_under(root))
        ),
    ]
    made: dict[str, InoRef] = {"/": by_ino(root)}
    numbers = itertools.count(1)

    def place(p: str, mode: int, data: bytes | None) -> None:
        up = made.get(parent(p))
        if up is None:
            return
        ref = InoRef(RESTORED_INO, (next(numbers),))
        seconds, nanoseconds = stamp_of(modified[p]) if p in modified else now
        size = len(data) if data is not None else 0
        statements.extend(
            [
                SqlStatement(
                    "INSERT INTO fs_inode (ino, mode, size, mtime,"
                    f" mtime_nsec) VALUES ({ref.sql}, ?, ?, ?, ?)",
                    (*ref.params, mode, size, seconds, nanoseconds),
                ),
                SqlStatement(
                    "INSERT INTO fs_dentry (name, parent_ino, ino)"
                    f" VALUES (?, {up.sql}, {ref.sql})",
                    (gnu_basename(p), *up.params, *ref.params),
                ),
            ]
        )
        if data is None:
            made[p] = ref
            return
        statements.extend(
            insert_rows(
                "INSERT INTO fs_data (ino, chunk_index, data)",
                f"({ref.sql}, ?, ?)",
                [
                    (*ref.params, i, data[at : at + cs])
                    for i, at in enumerate(range(0, len(data), cs))
                ],
            )
        )

    for p in sorted(
        (d for d in dirs if d != "/"), key=lambda d: (depth(d), d)
    ):
        place(p, DIR, None)
    for p, data in files.items():
        place(p, FILE, data)
    renumbered = RENUMBERED[accessor.driver.dialect]
    if renumbered is not None:
        statements.append(SqlStatement(renumbered))
    statements.append(SqlStatement(SQL["drop_base"]))
    accessor.driver.batch(statements)
