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

from dataclasses import dataclass

from mirage.runtime.types import VFSStat
from mirage.utils.stat_view import BLKSIZE, BLOCK_UNIT, ident


@dataclass(frozen=True, slots=True)
class PosixStat:
    """One path's stat as a POSIX kernel fills it, from a mount's row.

    Every runtime that answers a guest's stat (the host entry points,
    WASI, QuickJS) reads its fields here and spells them in its own
    shape, so a link count, an owner, a block count or an inode is the
    same number whichever one is asked.

    Args:
        mode (int): st_mode, type bits included.
        ino (int): the path's id.
        dev (int): the owning mount's id.
        nlink (int): 2 for a directory, its parent's entry and its own
            .; 1 for anything else.
        uid (int): the owner the row reports, else the fallback.
        gid (int): the group, read the same way.
        rdev (int): a device's numbers, 0 for anything else.
        size (int): st_size.
        atime_ns (int): access time; the modification time when the row
            has none.
        mtime_ns (int): modification time; the fallback when unknown.
        ctime_ns (int): change time, which a mount does not keep apart
            from the modification time.
        blksize (int): the block size.
        blocks (int): 512-byte blocks the size takes.
    """

    mode: int
    ino: int
    dev: int
    nlink: int
    uid: int
    gid: int
    rdev: int
    size: int
    atime_ns: int
    mtime_ns: int
    ctime_ns: int
    blksize: int
    blocks: int


def posix_stat(
    row: VFSStat,
    path: str,
    prefix: str,
    *,
    uid: int = 0,
    gid: int = 0,
    unknown_ns: int = 0,
) -> PosixStat:
    """The POSIX stat a runtime reports for one mount row.

    Args:
        row (VFSStat): the mount's row for the path.
        path (str): the path, which names the inode.
        prefix (str): the owning mount's prefix, which names the device.
        uid (int): the owner a row without one reports: a host
            process's own, 0 in a sandbox.
        gid (int): the group, read the same way.
        unknown_ns (int): what an unknown modification time reads as.
    """
    mtime = unknown_ns if row.mtime_ns is None else row.mtime_ns
    return PosixStat(
        mode=row.mode,
        ino=ident(path),
        dev=ident(prefix),
        nlink=2 if row.is_dir else 1,
        uid=uid if row.uid is None else row.uid,
        gid=gid if row.gid is None else row.gid,
        rdev=row.rdev,
        size=row.size,
        atime_ns=mtime if row.atime_ns is None else row.atime_ns,
        mtime_ns=mtime,
        ctime_ns=mtime,
        blksize=BLKSIZE,
        blocks=-(-row.size // BLOCK_UNIT),
    )
