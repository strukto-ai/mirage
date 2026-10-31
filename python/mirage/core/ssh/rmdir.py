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
from mirage.core.ssh.utils import holds_entries, join_root
from mirage.errors.fs import enoent, enotdir, enotempty
from mirage.types import PathSpec


async def rmdir(accessor: SSHAccessor, path: PathSpec) -> None:
    """Remove an empty directory over SFTP.

    The server enforces emptiness, so the work here is naming its
    refusal in the same vocabulary every other backend uses. SFTP 3 has
    one generic code for it (``SFTPFailure``, carrying only the server's
    message string), and later protocol versions split
    ``SFTPDirNotEmpty`` out; OpenSSH speaks version 3, so the generic
    code is what a not-empty rmdir actually answers in practice. It also
    covers other refusals, so one listing probe decides instead of a
    blind translation: only a directory that still shows entries
    converts to ENOTEMPTY, anything else keeps the server's own answer.
    Without the conversion the hidden-remnant guard never fires on ssh
    (it keys on the errno), and the raw SFTP failure leaks.

    Args:
        accessor (SSHAccessor): SSH accessor.
        path (PathSpec): directory to remove.
    """
    config = accessor.config
    sftp = await accessor.sftp()
    remote = join_root(config.root, path.mount_path)
    try:
        await sftp.rmdir(remote)
    except asyncssh.SFTPNoSuchFile as exc:
        raise enoent(path) from exc
    except asyncssh.SFTPDirNotEmpty as exc:
        raise enotempty(path) from exc
    except asyncssh.SFTPNotADirectory as exc:
        raise enotdir(path) from exc
    except asyncssh.SFTPFailure as exc:
        if await holds_entries(sftp, remote):
            raise enotempty(path) from exc
        raise
