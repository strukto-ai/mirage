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

from mirage.mount.types import MountAttrs
from mirage.types import FileStat
from mirage.utils.dates import iso_timestamp
from mirage.utils.stat_view import DIR_MODE, FILE_MODE, LINK_MODE


def dir_stat(uid: int, gid: int, now: float) -> MountAttrs:
    """The row a directory reports before any overlay.

    Args:
        uid (int): the mounting user.
        gid (int): the mounting group.
        now (float): the mount's construction time, used for every entry
            the backend cannot date.

    Returns:
        MountAttrs: the base directory row.
    """
    return MountAttrs(mode=DIR_MODE,
                      size=0,
                      nlink=2,
                      uid=uid,
                      gid=gid,
                      atime=now,
                      mtime=now,
                      ctime=now)


def file_stat(size: int, uid: int, gid: int, now: float) -> MountAttrs:
    """The row a regular file reports before any overlay.

    Args:
        size (int): byte length a client should see.
        uid (int): the mounting user.
        gid (int): the mounting group.
        now (float): the mount's construction time.

    Returns:
        MountAttrs: the base file row.
    """
    return MountAttrs(mode=FILE_MODE,
                      size=size,
                      nlink=1,
                      uid=uid,
                      gid=gid,
                      atime=now,
                      mtime=now,
                      ctime=now)


def apply_stat_attrs(entry: MountAttrs, s: FileStat) -> MountAttrs:
    """Fold the backend's merged stat onto a base row.

    The ops stat already carries the namespace overlay (chmod bits,
    chown ids, touched mtime), so honoring these fields here is what
    makes metadata ops visible through a mount. String uid/gid (names)
    are skipped: the kernel wants numeric ids and there is no user db to
    map against.

    Args:
        entry (MountAttrs): base row from dir_stat or file_stat.
        s (FileStat): the merged stat the ops facade returned.

    Returns:
        MountAttrs: the row with overlay fields applied.
    """
    if s.mode is not None:
        entry.mode = (entry.mode & ~0o7777) | (s.mode & 0o7777)
    if isinstance(s.uid, int):
        entry.uid = s.uid
    if isinstance(s.gid, int):
        entry.gid = s.gid
    if s.modified is not None:
        # Seconds, because that is what MountAttrs holds and what every
        # consumer of it wants: libfuse's st_mtime and nfstime3.seconds
        # are both seconds, and the nfs one is a u32 that saturates at
        # 2106 if it is handed nanoseconds. One translator per language:
        # the naive-stamp-is-UTC rule lives in dates.iso_timestamp,
        # never re-parsed here. None means the stamp did not parse;
        # epoch zero is a real time and lands.
        epoch = iso_timestamp(s.modified)
        if epoch is not None:
            entry.mtime = epoch
            entry.ctime = epoch
    return entry


def link_stat(target: str, row: FileStat | None, uid: int, gid: int,
              now: float) -> MountAttrs:
    """The row a namespace link reports, from its own node row.

    Built from the target string alone, every link over a mount answered
    the mount's construction time and the mounting user, so what
    ``chown -h`` and ``touch -h`` wrote was invisible through the
    kernel. The row passed here is the one the door answers a no-follow
    stat with. Size stays the displayable target's length (what this
    mount's readlink returns), and the mode is always lrwxrwxrwx: a
    symlink's permission bits are not consulted by any POSIX system.

    Args:
        target (str): the target as this mount presents it.
        row (FileStat | None): the link's own node row, when the
            namespace holds one.
        uid (int): the mounting user.
        gid (int): the mounting group.
        now (float): the mount's construction time.

    Returns:
        MountAttrs: the link's row.
    """
    entry = file_stat(len(target.encode()), uid, gid, now)
    if row is not None:
        entry = apply_stat_attrs(entry, row)
    entry.mode = LINK_MODE
    return entry
