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
from stat import S_IFDIR, S_IFLNK, S_IFREG

from mirage.accessor.sql import SqlAccessor
from mirage.core.sql.constants import LAST_INO, MAX_PARAMS, SQL
from mirage.types import FileStat, FileType
from mirage.utils.clock import system_date
from mirage.utils.dates import to_iso_z
from mirage.utils.filetype import content_type_for_path
from mirage.utils.path import gnu_basename
from mirage.utils.stat_view import ALL_MODE_BITS, S_IFMT
from mirage.vfs.sql.types import SqlRow, SqlStatement, SqlValue

# A time as ``fs_inode`` keeps it: whole seconds since the epoch and the
# nanoseconds past them.
Stamp = tuple[int, int]


@dataclass(frozen=True)
class Inode:
    """One ``fs_inode`` row. Mirrors TypeScript's ``Inode``."""

    ino: int
    mode: int
    nlink: int
    uid: int
    gid: int
    size: int
    atime: int
    atime_nsec: int
    mtime: int
    mtime_nsec: int
    ctime: int
    ctime_nsec: int


def inode_of(row: SqlRow | None, prefix: str = "") -> Inode | None:
    """The inode ``row`` holds under column names ``prefix`` starts, or
    None when the row has none (a name the walk did not find)."""
    if row is None or row.get(f"{prefix}ino") is None:
        return None
    n = {c: int(row.get(prefix + c) or 0) for c in Inode.__dataclass_fields__}
    return Inode(**n)


def is_dir(node: Inode) -> bool:
    return node.mode & S_IFMT == S_IFDIR


def is_file(node: Inode) -> bool:
    return node.mode & S_IFMT == S_IFREG


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
    """What ``stat`` answers for the inode at mount path ``p``. AgentFS
    records owner 0 for a file nobody chowned, so 0 reads as no owner,
    and ``ls -l`` shows the session's user as it does on a mount that
    keeps none. Mirrors TypeScript's ``inodeStat``."""
    kind = node.mode & S_IFMT
    if kind == S_IFDIR:
        file_type = FileType.DIRECTORY
    elif kind == S_IFLNK:
        file_type = FileType.SYMLINK
    else:
        file_type = FileType.FILE
    return FileStat(
        name=gnu_basename(p),
        size=None if file_type == FileType.DIRECTORY else node.size,
        modified=iso_of(node.mtime, node.mtime_nsec),
        type=file_type,
        content=(
            content_type_for_path(p) if file_type == FileType.FILE else None
        ),
        mode=node.mode & ALL_MODE_BITS,
        uid=node.uid or None,
        gid=node.gid or None,
        atime=iso_of(node.atime, node.atime_nsec),
        ctime=iso_of(node.ctime, node.ctime_nsec),
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
    the entry takes the number the inode was just given."""
    seconds, nanoseconds = stamp
    return [
        SqlStatement(
            SQL["new_inode"],
            (
                mode,
                size,
                seconds,
                nanoseconds,
                seconds,
                nanoseconds,
                seconds,
                nanoseconds,
            ),
        ),
        SqlStatement(
            "INSERT INTO fs_dentry (name, parent_ino, ino) VALUES"
            f" (?, {parent.sql}, {LAST_INO[accessor.driver.dialect]})",
            (name, *parent.params),
        ),
    ]


def resized(ino: InoRef, size: int, stamp: Stamp) -> SqlStatement:
    """Set the inode's size, and its mtime and ctime to ``stamp``."""
    seconds, nanoseconds = stamp
    return SqlStatement(
        "UPDATE fs_inode SET size = ?, mtime = ?, mtime_nsec = ?,"
        f" ctime = ?, ctime_nsec = ? WHERE ino = {ino.sql}",
        (size, seconds, nanoseconds, seconds, nanoseconds, *ino.params),
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


def reap(inos: Sequence[int]) -> list[SqlStatement]:
    """After entries naming ``inos`` were removed: count each one's links
    afresh and drop each that has none left, its bytes and link target
    with it. A file another entry still names (a hard link) keeps
    everything."""
    out: list[SqlStatement] = []
    for i in range(0, len(inos), 500):
        listed = ", ".join(by_ino(ino).sql for ino in inos[i : i + 500])
        gone = (
            f"SELECT ino FROM fs_inode WHERE ino IN ({listed}) AND nlink = 0"
        )
        out += [
            SqlStatement(
                "UPDATE fs_inode SET nlink = (SELECT COUNT(*) FROM"
                " fs_dentry d WHERE d.ino = fs_inode.ino)"
                f" WHERE ino IN ({listed})"
            ),
            SqlStatement(f"DELETE FROM fs_data WHERE ino IN ({gone})"),
            SqlStatement(f"DELETE FROM fs_symlink WHERE ino IN ({gone})"),
            SqlStatement(
                f"DELETE FROM fs_inode WHERE ino IN ({listed}) AND nlink = 0"
            ),
        ]
    return out
