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
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import eacces, enoent
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import epoch_to_iso
from mirage.utils.filetype import content_type_for_path


async def stat(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    virtual = path_spec.virtual
    path = path_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        remote_path = join_root(config.root, path)
        attrs = await sftp.stat(remote_path)
        is_dir = attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
        name = path.rstrip("/").rsplit("/", 1)[-1] or "/"
        mod_str = ""
        if attrs.mtime is not None:
            mod_str = epoch_to_iso(attrs.mtime)
        # Fields setattr applies natively (mode, times) read from the
        # remote inode, so external chmod/utime stays visible, mirroring
        # disk. Ownership can never be applied natively (chown over SFTP
        # needs privileges), so it lives wholly in the namespace overlay;
        # server-side uid/gid numbers would also be machine-dependent
        # noise. A directory has no rendered byte length, so its size is
        # None whatever the remote inode reports.
        return FileStat(
            name=name,
            size=None if is_dir else attrs.size,
            modified=mod_str,
            fingerprint=mod_str or None,
            type=FileType.DIRECTORY if is_dir else FileType.FILE,
            content=None if is_dir else content_type_for_path(path),
            mode=(
                attrs.permissions & 0o7777
                if attrs.permissions is not None
                else None
            ),
            atime=(
                epoch_to_iso(attrs.atime) if attrs.atime is not None else None
            ),
        )
    except asyncssh.SFTPPermissionDenied as exc:
        raise eacces(virtual) from exc
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)
