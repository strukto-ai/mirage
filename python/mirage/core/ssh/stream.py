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
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_stream(accessor: SSHAccessor,
                      path: PathSpec,
                      index=None,
                      chunk_size: int = 8192):
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        remote_path = _abs(config, path)
        async with sftp.open(remote_path, "rb") as f:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                yield chunk
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)


async def range_read(accessor: SSHAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        remote_path = _abs(config, path)
        async with sftp.open(remote_path, "rb") as f:
            await f.seek(start)
            return await f.read(end - start)
    except asyncssh.SFTPNoSuchFile:
        raise enoent(path)
