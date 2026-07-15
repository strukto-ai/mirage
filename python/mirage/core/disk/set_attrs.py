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
from datetime import datetime

import aiofiles.os

from mirage.accessor.disk import DiskAccessor
from mirage.core.disk.stat import _resolve
from mirage.types import PathSpec

aio_chmod = aiofiles.os.wrap(os.chmod)
aio_utime = aiofiles.os.wrap(os.utime)


async def set_attrs(
    accessor: DiskAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Write metadata fields (the write side of stat).

    Applies natively what the real inode can take and returns the
    residual: fields the caller must overlay elsewhere. Times always
    apply. ``mode`` is applied with owner access kept (``chmod 000``
    must not lock mirage itself out of reads, cp, or snapshot capture;
    mount mode does real access control), so clamped bits come back as
    residual. Ownership never applies (chown to arbitrary ids needs
    privileges the process does not have) and is always residual.

    Args:
        accessor (DiskAccessor): backend handle.
        path (PathSpec): target path.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.

    Returns:
        dict[str, int | str]: requested fields the inode does not hold.
    """
    p = _resolve(accessor.root, path.mount_path)
    if not await aiofiles.os.path.exists(p):
        raise FileNotFoundError(path.raw_path)
    residual: dict[str, int | str] = {}
    if mode is not None:
        keep = 0o700 if await aiofiles.os.path.isdir(p) else 0o600
        await aio_chmod(p, mode | keep)
        if mode | keep != mode:
            residual["mode"] = mode
    if uid is not None:
        residual["uid"] = uid
    if gid is not None:
        residual["gid"] = gid
    if atime is not None or mtime is not None:
        st = await aiofiles.os.stat(p)
        new_atime = (datetime.fromisoformat(atime).timestamp()
                     if atime is not None else st.st_atime)
        new_mtime = (datetime.fromisoformat(mtime).timestamp()
                     if mtime is not None else st.st_mtime)
        await aio_utime(p, (new_atime, new_mtime))
    return residual
