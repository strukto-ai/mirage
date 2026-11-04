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

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import DIR, FILE, LAST_INO, MAX_PARAMS, SQL
from mirage.types import FileStat, FileType
from mirage.utils.clock import system_date
from mirage.utils.dates import to_iso_z
from mirage.utils.filetype import content_type_for_path
from mirage.utils.path import gnu_basename
from mirage.vfs.sql.types import SqlRow, SqlStatement, SqlValue

# A time as ``fs_inode`` keeps it: whole seconds since the epoch and the
# nanoseconds past them.
Stamp = tuple[int, int]


@dataclass(frozen=True)
class Inode:
    """One ``fs_inode`` row. Mirrors TypeScript's ``Inode``."""

    ino: int
    # The type bits: ``DIR`` or ``FILE``.
    mode: int
    size: int
    mtime: int
    mtime_nsec: int


def inode_of(row: SqlRow | None, prefix: str = "") -> Inode | None:
    """The inode ``row`` holds under column names ``prefix`` starts, or
    None when the row has none (a name the walk did not find)."""
    if row is None or row.get(f"{prefix}ino") is None:
        return None
    n = {c: int(row.get(prefix + c) or 0) for c in Inode.__dataclass_fields__}
    return Inode(**n)


def is_dir(node: Inode) -> bool:
    return node.mode == DIR


def is_file(node: Inode) -> bool:
    return node.mode == FILE


def now_stamp() -> Stamp:
    """Now, as ``fs_inode`` keeps a time."""
    now = system_date()
    return math.floor(now.timestamp()), now.microsecond * 1000


def stamp_of(iso: str) -> Stamp:
    """The stamp an ISO time names, to the nanosecond its fraction
    gives."""
    seconds = math.floor(
        datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    )
    match = re.search(r"\.(\d+)", iso)
    fraction = match.group(1) if match else ""
    return seconds, int(fraction.ljust(9, "0")[:9])


def iso_of(seconds: int, nanoseconds: int) -> str:
    """A stamp as ISO text, as ``to_iso_z`` writes it."""
    at = datetime.fromtimestamp(seconds, timezone.utc)
    return to_iso_z(at.replace(microsecond=nanoseconds // 1000))


def inode_stat(p: str, node: Inode) -> FileStat:
    """What ``stat`` answers for the inode at mount path ``p``: its type,
    size and mtime. The namespace overlay adds a mode, owner or atime set
    on the path. Mirrors TypeScript's ``inodeStat``."""
    modified = iso_of(node.mtime, node.mtime_nsec)
    if is_dir(node):
        return FileStat(
            name=gnu_basename(p), modified=modified, type=FileType.DIRECTORY
        )
    return FileStat(
        name=gnu_basename(p),
        size=node.size,
        modified=modified,
        type=FileType.FILE,
        content=content_type_for_path(p),
    )


@dataclass(frozen=True)
class InoRef:
    """An inode as a statement names it: by number once it is known,
    else by the entry a statement earlier in the same batch made for
    it."""

    sql: str
    params: tuple[SqlValue, ...] = ()


def by_ino(ino: int) -> InoRef:
    """The inode numbered ``ino``, written into the statement: an
    integer the database gave."""
    return InoRef(str(int(ino)))


def by_entry(parent: InoRef, name: str) -> InoRef:
    """The inode the entry ``name`` under ``parent`` holds."""
    return InoRef(
        f"(SELECT ino FROM fs_dentry WHERE parent_ino = {parent.sql}"
        " AND name = ?)",
        (*parent.params, name),
    )


def make_node(
    accessor: SqlAccessor,
    parent: InoRef,
    name: str,
    mode: int,
    size: int,
    stamp: Stamp,
) -> list[SqlStatement]:
    """A new inode of ``mode`` and ``size`` bytes, and the entry that
    names it ``name`` under ``parent``, as two statements of one batch:
    the entry takes the number the inode was just given. The parent is
    named through its inode, so a parent another writer removed since the
    lookup leaves the entry no parent, which its column refuses, and the
    batch fails whole rather than strand it."""
    seconds, nanoseconds = stamp
    return [
        SqlStatement(SQL["new_inode"], (mode, size, seconds, nanoseconds)),
        SqlStatement(
            "INSERT INTO fs_dentry (name, parent_ino, ino) VALUES"
            f" (?, (SELECT ino FROM fs_inode WHERE ino = {parent.sql}),"
            f" {LAST_INO[accessor.driver.dialect]})",
            (name, *parent.params),
        ),
    ]


def resized(ino: InoRef, size: int, stamp: Stamp) -> SqlStatement:
    """Set the inode's size, and its mtime to ``stamp``."""
    seconds, nanoseconds = stamp
    return SqlStatement(
        "UPDATE fs_inode SET size = ?, mtime = ?, mtime_nsec = ?"
        f" WHERE ino = {ino.sql}",
        (size, seconds, nanoseconds, *ino.params),
    )


def resized_from(node: Inode, size: int, stamp: Stamp) -> SqlStatement:
    """``resized``, landing only on the inode as ``node`` read it: a size
    or mtime another writer changed since leaves the size NULL, which its
    column refuses, so the batch fails whole and the caller reads the file
    again."""
    seconds, nanoseconds = stamp
    return SqlStatement(
        "UPDATE fs_inode SET size = CASE WHEN size = ? AND mtime = ?"
        " AND mtime_nsec = ? THEN CAST(? AS BIGINT) END,"
        f" mtime = ?, mtime_nsec = ? WHERE ino = {by_ino(node.ino).sql}",
        (
            node.size,
            node.mtime,
            node.mtime_nsec,
            size,
            seconds,
            nanoseconds,
        ),
    )


def insert_rows(
    head: str,
    row: str,
    rows: Sequence[Sequence[SqlValue]],
) -> list[SqlStatement]:
    """One multi-row INSERT per run of ``rows`` that fits ``MAX_PARAMS``:
    ``head`` is the statement up to VALUES, ``row`` one row's
    placeholders, and each entry of ``rows`` that row's parameters."""
    width = len(rows[0]) if rows else 1
    per = max(1, MAX_PARAMS // width)
    out: list[SqlStatement] = []
    for i in range(0, len(rows), per):
        run = rows[i : i + per]
        out.append(
            SqlStatement(
                f"{head} VALUES {', '.join(row for _ in run)}",
                tuple(v for r in run for v in r),
            )
        )
    return out


def _unnamed(table: str) -> str:
    # The row's inode is one no entry names.
    return f"NOT EXISTS (SELECT 1 FROM fs_dentry d WHERE d.ino = {table}.ino)"


def drop_inodes(inos: Sequence[int]) -> list[SqlStatement]:
    """After the entries naming ``inos`` were removed: each inode no
    entry names any more, and its bytes. One an entry still names keeps
    everything: a directory something was written under since, whose
    guarded removal kept its entry, or a file another writer moved, whose
    entry the removal missed."""
    out: list[SqlStatement] = []
    for i in range(0, len(inos), 500):
        listed = ", ".join(by_ino(ino).sql for ino in inos[i : i + 500])
        out += [
            SqlStatement(
                f"DELETE FROM fs_data WHERE ino IN ({listed})"
                f" AND {_unnamed('fs_data')}"
            ),
            SqlStatement(
                f"DELETE FROM fs_inode WHERE ino IN ({listed})"
                f" AND {_unnamed('fs_inode')}"
            ),
        ]
    return out


async def inode_at(accessor: SqlAccessor, ino: int) -> Inode | None:
    """The inode numbered ``ino`` as it is now, wherever an entry has it,
    or None once it is gone."""
    rows = await accessor.query(SQL["inode"], (ino,))
    return inode_of(rows[0] if rows else None)
