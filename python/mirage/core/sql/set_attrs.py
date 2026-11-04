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
from mirage.core.sql.inode import by_ino, now_stamp, stamp_of
from mirage.core.sql.path import found, walk
from mirage.types import PathSpec
from mirage.utils.stat_view import ALL_MODE_BITS, S_IFMT
from mirage.vfs.sql.types import SqlStatement, SqlValue


async def set_attrs(
    accessor: SqlAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Write metadata fields onto an entry's inode (the write side of
    stat), and its ctime with them. The inode keeps a numeric owner; an
    owner given by name is no column's, so it comes back as the
    residual, which the namespace's overlay keeps. Stored, not enforced:
    mount mode does real access control. Mirrors TypeScript's
    ``setAttrs``."""
    node = found(walk(accessor, path), path)
    sets: list[str] = []
    params: list[SqlValue] = []
    residual: dict[str, int | str] = {}
    if mode is not None:
        sets.append("mode = ?")
        params.append((node.mode & S_IFMT) | (mode & ALL_MODE_BITS))
    for key, value in (("uid", uid), ("gid", gid)):
        if value is None:
            continue
        if isinstance(value, int) or value.isdigit():
            sets.append(f"{key} = ?")
            params.append(int(value))
        else:
            residual[key] = value
    for key, when in (("atime", atime), ("mtime", mtime)):
        if when is None:
            continue
        seconds, nanoseconds = stamp_of(when)
        sets += [f"{key} = ?", f"{key}_nsec = ?"]
        params += [seconds, nanoseconds]
    if not sets:
        return residual
    seconds, nanoseconds = now_stamp()
    accessor.batch(
        [
            SqlStatement(
                f"UPDATE fs_inode SET {', '.join(sets)}, ctime = ?, ctime_nsec = ?"
                f" WHERE ino = {by_ino(node.ino).sql}",
                (*params, seconds, nanoseconds),
            )
        ]
    )
    return residual
