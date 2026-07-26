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

from mirage.core.ssh._client import _abs
from mirage.core.ssh.config import SSHConfig


async def walk(
    sftp: asyncssh.SFTPClient,
    config: SSHConfig,
    path: str,
    results: list[tuple[str, int]] | None,
) -> int:
    """Sum file sizes under a mount-relative path over SFTP.

    Args:
        sftp (asyncssh.SFTPClient): open SFTP channel.
        config (SSHConfig): backend config, for the remote root.
        path (str): mount-relative directory to walk.
        results (list[tuple[str, int]] | None): when given, collects
            mount-relative (path, size) pairs for each file found.
    """
    total = 0
    try:
        listing = await sftp.readdir(_abs(config, path))
    except asyncssh.SFTPNoSuchFile:
        raise FileNotFoundError(path)
    for entry in listing:
        if entry.filename in (".", ".."):
            continue
        child = f"{path.rstrip('/')}/{entry.filename}"
        if entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
            total += await walk(sftp, config, child, results)
        else:
            size = entry.attrs.size or 0
            if results is not None:
                results.append((child, size))
            total += size
    return total
