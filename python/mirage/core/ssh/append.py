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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.ssh.utils import join_root, open_for_write
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def append_bytes(
    accessor: SSHAccessor, path: PathSpec, data: bytes
) -> None:
    config = accessor.config
    timer = start_op()
    sftp = await accessor.sftp()
    async with await open_for_write(
        sftp, join_root(config.root, path.mount_path), path, flags="ab"
    ) as f:
        await f.write(data)
    record("append", path.virtual, "ssh", len(data), timer)
    await invalidate_after_write(path)
