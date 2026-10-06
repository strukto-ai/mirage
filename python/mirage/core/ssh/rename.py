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
from mirage.cache.context import invalidate_subtree
from mirage.core.ssh.utils import join_root
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def rename(
    accessor: SSHAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    # POSIX rename semantics (replace an existing destination); plain SFTP
    # rename refuses to overwrite, so prefer posix-rename@openssh.com.
    try:
        await sftp.posix_rename(
            join_root(config.root, src), join_root(config.root, dst)
        )
    except asyncssh.SFTPOpUnsupported:
        try:
            await sftp.rename(
                join_root(config.root, src), join_root(config.root, dst)
            )
        except asyncssh.SFTPNoSuchFile:
            raise enoent(src)
    except asyncssh.SFTPNoSuchFile:
        raise enoent(src)
    # Both sides are subtree evictions: a rename destroys the destination's
    # previous identity and relocates everything under the source, so a
    # listing or body cached below either name is now stale.
    await invalidate_subtree(dst_spec)
    await invalidate_subtree(src_spec)
