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

import asyncio
import logging
import os
import sys
from pathlib import Path
from stat import S_ISDIR

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.listing_version import stamp, wall_ns
from mirage.core.disk.utils import resolve_inside_sync
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import ns_to_iso
from mirage.utils.filetype import content_type_for_path

logger = logging.getLogger(__name__)

# Linux counts a folder's links as itself, its "." and each subfolder's
# "..", and its blocks as ext4 allocates them. Other hosts count
# otherwise (APFS counts every entry and gives a folder no blocks), so
# there the folder's links are counted as Linux would and its blocks
# left to the ext4 default.
LINUX = sys.platform.startswith("linux")


def _folder_links(path: str) -> int | None:
    """A folder's link count as Linux has it: 2, and 1 per subfolder;
    None for one that went before it was counted.

    Args:
        path (str): the folder on the host.
    """
    try:
        with os.scandir(path) as entries:
            return 2 + sum(
                entry.is_dir(follow_symlinks=False) for entry in entries
            )
    except OSError as exc:
        logger.debug("%s: links not counted: %s", path, exc)
        return None


def stat_of(
    name: str,
    st: os.stat_result,
    now_ns: int,
    versioned: bool,
    path: str,
) -> FileStat:
    """What ``stat`` answers for a host entry, from its host stat.

    Args:
        name (str): the entry's name.
        st (os.stat_result): its host stat.
        now_ns (int): the wall clock, read before the stat.
        versioned (bool): whether the mount stores folder versions.
        path (str): where the entry is on the host, whose subfolders
            give a folder its link count off Linux.
    """
    modified = ns_to_iso(st.st_mtime_ns)
    # Only BSD and macOS report a birth time, and only as float seconds.
    born = getattr(st, "st_birthtime", None)
    birthtime = None
    if born is not None:
        birthtime = ns_to_iso(round(born * 1_000_000_000))
    # Fields setattr applies natively (mode, times) read from the real
    # inode, so external chmod/utime stays visible. Ownership can never
    # be applied natively (chown needs privileges), so it lives wholly
    # in the namespace overlay, merged at the stat-merge layer; host
    # uid/gid numbers would also be machine-dependent noise.
    if S_ISDIR(st.st_mode):
        # A folder's fingerprint is the version its listing is stored at,
        # so the listing gate's check and the readdir fill agree.
        return FileStat(
            name=name,
            size=None,
            modified=modified,
            fingerprint=stamp(st, now_ns) if versioned else None,
            type=FileType.DIRECTORY,
            mode=st.st_mode & 0o7777,
            atime=ns_to_iso(st.st_atime_ns),
            ctime=ns_to_iso(st.st_ctime_ns),
            birthtime=birthtime,
            nlink=st.st_nlink if LINUX else _folder_links(path),
            blocks=st.st_blocks if LINUX else None,
        )
    return FileStat(
        name=name,
        size=st.st_size,
        modified=modified,
        fingerprint=modified,
        type=FileType.FILE,
        content=content_type_for_path(name),
        mode=st.st_mode & 0o7777,
        atime=ns_to_iso(st.st_atime_ns),
        ctime=ns_to_iso(st.st_ctime_ns),
        birthtime=birthtime,
        nlink=st.st_nlink,
        blocks=getattr(st, "st_blocks", None),
    )


async def stat(accessor: DiskAccessor, path_spec: PathSpec) -> FileStat:
    def host() -> tuple[Path, os.stat_result, int]:
        p = resolve_inside_sync(accessor.root, path_spec)
        now_ns = wall_ns()
        # One stat, restamped: an existence check first would read ENOTDIR
        # (a path under a plain file) as plain absence.
        with disk_errors(path_spec.virtual):
            return p, os.stat(p), now_ns

    def row() -> FileStat:
        p, st, now_ns = host()
        return stat_of(p.name, st, now_ns, accessor.folder_versions, str(p))

    return await asyncio.to_thread(row)
