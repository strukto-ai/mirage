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

from typing import TypedDict

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import CLEAR, DIR, FILE, ROOT_INO, SQL
from mirage.core.sql.data import place_bytes, read_bytes
from mirage.core.sql.inode import (
    InoRef,
    by_entry,
    by_ino,
    inode_of,
    is_dir,
    is_file,
    iso_of,
    make_node,
    now_stamp,
    stamp_of,
)
from mirage.utils.path import gnu_basename, parent
from mirage.vfs.sql.types import SqlStatement


class SqlSnapshot(TypedDict):
    """What a snapshot keeps of a sql mount: each file's bytes and each
    directory, by mount path, with the mtime of each. A path's mode and
    owner are the namespace's, which the workspace snapshots itself.
    Mirrors TypeScript's ``SqlSnapshot``."""

    files: dict[str, bytes]
    dirs: list[str]
    modified: dict[str, str]


def depth(p: str) -> int:
    return p.count("/")


def snapshot(accessor: SqlAccessor) -> SqlSnapshot:
    """Every file and directory of the database, read in one walk of the
    tree. Synchronous, as ``get_state`` calls it. Mirrors TypeScript's
    ``snapshot``."""
    files: dict[str, bytes] = {}
    dirs = ["/"]
    modified: dict[str, str] = {}
    for row in accessor.query(SQL["subtree"], (ROOT_INO,)):
        node = inode_of(row)
        if node is None or not (is_dir(node) or is_file(node)):
            continue
        p = "/" + str(row["rel"])
        if is_dir(node):
            dirs.append(p)
        else:
            files[p] = read_bytes(accessor, node)
        modified[p] = iso_of(node.mtime, node.mtime_nsec)
    return SqlSnapshot(files=files, dirs=sorted(dirs), modified=modified)


def restore(
    accessor: SqlAccessor,
    *,
    files: dict[str, bytes],
    dirs: list[str],
    modified: dict[str, str],
) -> None:
    """Replace everything the database holds with a snapshot, in one
    transaction: the directories outermost first, then each file under
    its directory. A path whose directory the snapshot does not hold is
    dropped. Mirrors TypeScript's ``restore``."""
    statements = [SqlStatement(sql) for sql in CLEAR]
    refs: dict[str, InoRef] = {"/": by_ino(ROOT_INO)}
    now = now_stamp()

    def place(p: str, mode: int, data: bytes | None) -> None:
        up = refs.get(parent(p))
        if up is None:
            return
        name = gnu_basename(p)
        ref = by_entry(up, name)
        stamp = stamp_of(modified[p]) if p in modified else now
        statements.extend(
            make_node(
                accessor,
                up,
                name,
                mode,
                len(data) if data is not None else 0,
                stamp,
            )
        )
        if data is not None:
            statements.extend(place_bytes(accessor, ref, None, 0, data))
        if data is None:
            refs[p] = ref

    for p in sorted(
        (d for d in dirs if d != "/"), key=lambda d: (depth(d), d)
    ):
        place(p, DIR, None)
    for p, data in files.items():
        place(p, FILE, data)
    accessor.batch(statements)
