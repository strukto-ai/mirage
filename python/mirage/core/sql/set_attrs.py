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
from mirage.core.sql.inode import by_ino, stamp_of, touched
from mirage.core.sql.path import found, walk
from mirage.observe.context import record, start_op
from mirage.types import PathSpec, VFSName


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
    """Set an entry's mtime in its inode, to the nanosecond the time
    gives, and hand back every other field, which the store keeps no
    column for. Mirrors TypeScript's ``setAttrs``.

    Args:
        accessor (SqlAccessor): the mount's database.
        path (PathSpec): the entry.
        mode (int | None): permission bits.
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.

    Returns:
        dict[str, int | str]: the fields not applied here.
    """
    timer = start_op()
    w = await walk(accessor, path)
    node = found(w, path)
    if mtime is not None:
        await accessor.batch([touched(by_ino(node.ino), stamp_of(mtime))])
    record("setattr", path.virtual, VFSName.SQL, 0, timer)
    asked: dict[str, int | str | None] = {
        "mode": mode,
        "uid": uid,
        "gid": gid,
        "atime": atime,
    }
    return {key: value for key, value in asked.items() if value is not None}
