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

import asyncssh

from mirage.core.ssh.constants import FXF_CREAT, FXF_WRITE
from mirage.errors.fs import eisdir, enoent
from mirage.types import PathSpec


def join_root(root: str, rel: str) -> str:
    """The remote path of a mount-relative path under the configured root.

    Args:
        root (str): the remote directory the mount is rooted at.
        rel (str): the mount-relative path; a leading slash is ignored.
    """
    base = root.rstrip("/")
    stripped = rel.lstrip("/")
    if not stripped:
        return base or "/"
    return f"{base}/{stripped}"


async def open_for_write(
    sftp: asyncssh.SFTPClient, remote: str, path: PathSpec
) -> asyncssh.SFTPClientFile:
    """Open a remote file for writing, creating it and cutting nothing.

    OpenSSH answers an open of a directory with SFTP 3's one generic
    refusal (``SFTPFailure``), so a stat decides whether it was one;
    a missing parent is ``SFTPNoSuchFile``. Both leave in the errno
    every other backend uses.

    Args:
        sftp (asyncssh.SFTPClient): the mount's SFTP session.
        remote (str): the remote path, under the mount's root.
        path (PathSpec): the virtual path, for the error.
    """
    try:
        return await sftp.open(remote, FXF_WRITE | FXF_CREAT, encoding=None)
    except asyncssh.SFTPNoSuchFile as exc:
        raise enoent(path) from exc
    except asyncssh.SFTPFailure as exc:
        if await sftp.isdir(remote):
            raise eisdir(path) from exc
        raise
