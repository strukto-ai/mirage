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

import time

import asyncssh

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.ssh._client import _abs
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_bytes(accessor: SSHAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    start_ms = int(time.monotonic() * 1000)
    try:
        remote_path = _abs(config, path)
        async with sftp.open(remote_path, "rb") as f:
            if offset:
                await f.seek(offset)
            data = await f.read(size if size is not None else -1)
        record("read", path, "ssh", len(data), start_ms)
        return data
    except asyncssh.SFTPNoSuchFile:
        raise enoent(virtual)
