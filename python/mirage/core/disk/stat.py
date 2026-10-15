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

import os
from stat import S_ISDIR

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.errors import disk_errors
from mirage.core.disk.listing_version import stamp, wall_ns
from mirage.core.disk.utils import resolve_inside
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import ns_to_iso
from mirage.utils.filetype import content_type_for_path


def stat_of(
    name: str, st: os.stat_result, now_ns: int, versioned: bool
) -> FileStat:
    """What ``stat`` answers for a host entry, from its host stat.

    Args:
        name (str): the entry's name.
        st (os.stat_result): its host stat.
        now_ns (int): the wall clock, read before the stat.
        versioned (bool): whether the mount stores folder versions.
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
    )


async def stat(accessor: DiskAccessor, path_spec: PathSpec) -> FileStat:
    p = await resolve_inside(accessor.root, path_spec)
    now_ns = wall_ns()
    # One stat, restamped: an existence check first would read ENOTDIR
    # (a path under a plain file) as plain absence.
    with disk_errors(path_spec.virtual):
        st = await aiofiles.os.stat(p)
    return stat_of(p.name, st, now_ns, accessor.folder_versions)
