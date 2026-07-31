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

from datetime import datetime

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh._client import _abs
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def set_attrs(
    accessor: SSHAccessor,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> dict[str, int | str]:
    """Write metadata fields (the write side of stat), mirroring disk.

    Applies natively what the remote inode can take and returns the
    residual: fields the caller must overlay elsewhere. Times always
    apply via SFTP utime, so touch results live on the real file and
    out-of-band readers see them. ``mode`` is applied with owner access
    kept (``chmod 000`` must not lock mirage's own SFTP session out of
    reads; mount mode does real access control), so clamped bits come
    back as residual. Ownership never applies (chown over SFTP needs
    privileges the login user does not have) and is always residual.

    Args:
        accessor (SSHAccessor): backend handle.
        path (PathSpec): target path.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.

    Returns:
        dict[str, int | str]: requested fields the remote inode does
        not hold.
    """
    sftp = await accessor.sftp()
    remote = _abs(accessor.config, path.mount_path)
    try:
        attrs = await sftp.stat(remote)
    except asyncssh.SFTPNoSuchFile:
        raise enoent(path.raw_path)
    residual: dict[str, int | str] = {}
    if mode is not None:
        is_dir = attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
        keep = 0o700 if is_dir else 0o600
        await sftp.chmod(remote, mode | keep)
        if mode | keep != mode:
            residual["mode"] = mode
    if uid is not None:
        residual["uid"] = uid
    if gid is not None:
        residual["gid"] = gid
    if atime is not None or mtime is not None:
        new_atime = (datetime.fromisoformat(atime).timestamp()
                     if atime is not None else attrs.atime or 0.0)
        new_mtime = (datetime.fromisoformat(mtime).timestamp()
                     if mtime is not None else attrs.mtime or 0.0)
        await sftp.utime(remote, times=(new_atime, new_mtime))
    return residual
