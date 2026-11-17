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

import logging

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.posix.constants import COPIED
from mirage.core.posix.copy import copy_tree_command
from mirage.core.posix.errors import refusal
from mirage.core.posix.utils import join_root
from mirage.errors.fs import enoent, enotsup
from mirage.observe.context import lift_lost, lost_count, record, start_op
from mirage.types import PathSpec, VFSName

logger = logging.getLogger(__name__)


async def copy(
    accessor: SSHAccessor, src_spec: PathSpec, dst_spec: PathSpec
) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        async with sftp.open(join_root(config.root, src), "rb") as f:
            content = await f.read()
        async with sftp.open(join_root(config.root, dst), "wb") as f:
            await f.write(content)
    except asyncssh.SFTPNoSuchFile:
        raise enoent(src)


async def dir_copy(
    accessor: SSHAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Copy a directory tree onto a fresh name with one ``cp -RL`` on the
    server, which follows links as the mount's listing does.

    A server that runs no commands leaves nothing at ``dst``: that is
    ENOTSUP, and ``cp -r`` walks the tree itself.

    Args:
        accessor (SSHAccessor): the mount's connection.
        src (PathSpec): the directory.
        dst (PathSpec): the copy.
    """
    root = accessor.config.root
    command = copy_tree_command(
        join_root(root, src.mount_path), join_root(root, dst.mount_path)
    )
    upto = lost_count()
    timer = start_op()
    try:
        status, out, err = await accessor.run(command)
    except (asyncssh.Error, OSError) as exc:
        logger.debug("ssh tree copy left to the walk: %s", exc)
        raise enotsup(VFSName.SSH, "dir_copy", dst) from exc
    if status == 0 and out == COPIED:
        record("copy_prefix", dst.virtual, "ssh", 0, timer)
        lift_lost(dst, upto, subtree=True)
        return
    sftp = await accessor.sftp()
    if not await sftp.exists(join_root(root, dst.mount_path)):
        logger.debug("ssh tree copy left to the walk: %r", err)
        raise enotsup(VFSName.SSH, "dir_copy", dst)
    raise refusal(dst, err)
