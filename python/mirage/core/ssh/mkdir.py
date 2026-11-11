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
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import eacces, eexist, enoent, enotdir
from mirage.types import PathSpec
from mirage.utils.key_prefix import mounted_path


async def mkdir(
    accessor: SSHAccessor, path: PathSpec, parents: bool = False
) -> None:
    config = accessor.config
    sftp = await accessor.sftp()
    if parents:
        key = path.mount_path.strip("/")
        current = ""
        for part in filter(None, key.split("/")):
            current += "/" + part
            remote = join_root(config.root, current)
            if await sftp.isdir(remote):
                continue
            try:
                await sftp.mkdir(remote)
            except asyncssh.SFTPError as exc:
                if await sftp.isdir(remote):
                    continue
                # The step -p tripped on, in the kernel's words: a name in
                # the way is EEXIST at the operand and ENOTDIR above it.
                named = mounted_path(path, current)
                if isinstance(exc, asyncssh.SFTPPermissionDenied):
                    raise eacces(named) from exc
                if isinstance(exc, asyncssh.SFTPNoSuchFile):
                    raise enoent(named) from exc
                if isinstance(
                    exc, asyncssh.SFTPFailure
                ) and await sftp.lexists(remote):
                    last = current == "/" + key
                    raise (eexist if last else enotdir)(named) from exc
                raise
    else:
        remote = join_root(config.root, path.mount_path)
        try:
            await sftp.mkdir(remote)
        except asyncssh.SFTPNoSuchFile as exc:
            raise enoent(path) from exc
        except asyncssh.SFTPFailure as exc:
            # OpenSSH answers an existing target with SFTP 3's one
            # generic refusal; only a stat can tell it was EEXIST.
            if await sftp.exists(remote):
                raise eexist(path) from exc
            raise
