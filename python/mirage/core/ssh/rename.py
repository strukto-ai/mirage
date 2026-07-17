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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.ssh._client import _abs
from mirage.types import PathSpec


async def rename(accessor: SSHAccessor, src_spec: PathSpec,
                 dst_spec: PathSpec) -> None:
    src = src_spec.mount_path
    dst = dst_spec.mount_path
    config = accessor.config
    sftp = await accessor.sftp()
    try:
        await sftp.rename(_abs(config, src), _abs(config, dst))
    except asyncssh.SFTPNoSuchFile:
        raise FileNotFoundError(src)
    await invalidate_after_write(dst_spec)
    await invalidate_after_unlink(src_spec)
