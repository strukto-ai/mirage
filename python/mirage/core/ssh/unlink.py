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
from mirage.cache.context import invalidate_after_unlink
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import eisdir
from mirage.types import PathSpec


async def unlink(accessor: SSHAccessor, path: PathSpec) -> None:
    config = accessor.config
    sftp = await accessor.sftp()
    remote = join_root(config.root, path.mount_path)
    try:
        await sftp.remove(remote)
    except asyncssh.SFTPNoSuchFile:
        raise FileNotFoundError(path)
    except asyncssh.SFTPFailure as exc:
        # OpenSSH answers a directory with SFTP 3's one generic refusal;
        # Linux's unlink(2) says EISDIR.
        if await sftp.isdir(remote):
            raise eisdir(path) from exc
        raise
    await invalidate_after_unlink(path)
