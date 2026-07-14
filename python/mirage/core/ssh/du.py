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

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh._client import _abs
from mirage.core.ssh.stat import stat
from mirage.types import FileType, PathSpec


async def du(accessor: SSHAccessor, path: PathSpec) -> int:
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    target = path.mount_path if isinstance(path, PathSpec) else path
    config = accessor.config
    sftp = await accessor.sftp()
    return await _du_walk(sftp, _abs(config, target))


async def du_all(
    accessor: SSHAccessor,
    path: PathSpec,
) -> tuple[list[tuple[str, int]], int]:
    try:
        info = await stat(accessor, path)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return [], info.size or 0
    target = path.mount_path if isinstance(path, PathSpec) else path
    config = accessor.config
    sftp = await accessor.sftp()
    entries: list[tuple[str, int]] = []
    total = await _du_walk_all(sftp, config, target, entries)
    entries.sort()
    return entries, total


async def _du_walk(sftp, remote_path):
    total = 0
    try:
        entries = await sftp.readdir(remote_path)
    except asyncssh.SFTPNoSuchFile:
        raise FileNotFoundError(remote_path)
    for entry in entries:
        if entry.filename in (".", ".."):
            continue
        child = f"{remote_path.rstrip('/')}/{entry.filename}"
        if entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
            total += await _du_walk(sftp, child)
        else:
            total += entry.attrs.size or 0
    return total


async def _du_walk_all(sftp, config, path, results):
    remote = _abs(config, path)
    total = 0
    try:
        entries = await sftp.readdir(remote)
    except asyncssh.SFTPNoSuchFile:
        raise FileNotFoundError(path)
    for entry in entries:
        if entry.filename in (".", ".."):
            continue
        child = f"{path.rstrip('/')}/{entry.filename}"
        if entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY:
            total += await _du_walk_all(sftp, config, child, results)
        else:
            size = entry.attrs.size or 0
            results.append((child, size))
            total += size
    return total
