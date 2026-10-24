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
from contextlib import aclosing
from uuid import uuid4

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.core.ssh.utils import join_root, open_for_write
from mirage.io.cooperative import chunks
from mirage.io.stream import close_quietly
from mirage.io.types import ByteSource
from mirage.observe.context import record, start_op
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


async def write(
    accessor: SSHAccessor,
    path_spec: PathSpec,
    data: ByteSource,
    atomic: bool = False,
) -> None:
    timer = start_op()
    sftp = await accessor.sftp()
    remote = join_root(accessor.config.root, path_spec.mount_path)
    target = remote + ".mirage-" + uuid4().hex if atomic else remote
    staged = False
    size = 0
    mode = None
    try:
        if atomic:
            try:
                attrs = await sftp.stat(remote)
                mode = attrs.permissions
            except asyncssh.SFTPNoSuchFile:
                logger.debug("staging a new SSH file: %s", path_spec.virtual)
        handle = await open_for_write(
            sftp, target, path_spec, flags="xb" if atomic else "wb"
        )
        staged = atomic
        async with handle, aclosing(chunks(data)) as source:
            async for part in source:
                await handle.write(part)
                size += len(part)
        if atomic:
            if mode is not None:
                await sftp.chmod(target, mode & 0o7777)
            await sftp.posix_rename(target, remote)
            staged = False
    finally:
        await close_quietly(data)
        if staged:
            try:
                await sftp.remove(target)
            except Exception:
                logger.debug(
                    "Could not remove staged %s", target, exc_info=True
                )
    record("write", path_spec.virtual, "ssh", size, timer)
