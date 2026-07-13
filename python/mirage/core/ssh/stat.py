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
from mirage.cache.index import IndexCacheStore
from mirage.core.ssh._client import _abs
from mirage.core.timeutil import epoch_to_iso
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent
from mirage.utils.filetype import guess_type


async def stat(accessor: SSHAccessor,
               path: PathSpec,
               index: IndexCacheStore = None) -> FileStat:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        remote_path = _abs(config, path)
        attrs = await sftp.stat(remote_path)
        is_dir = attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY
        name = path.rstrip("/").rsplit("/", 1)[-1] or "/"
        mod_str = ""
        if attrs.mtime is not None:
            mod_str = epoch_to_iso(attrs.mtime)
        return FileStat(
            name=name,
            size=attrs.size or 0,
            modified=mod_str,
            fingerprint=mod_str or None,
            type=FileType.DIRECTORY if is_dir else guess_type(path),
        )
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)
