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
from mirage.utils.errors import enotsup


async def truncate(
    accessor: SSHAccessor,
    path: PathSpec,
    length: int = 0,
    no_create: bool = False,
) -> None:
    if no_create:
        raise enotsup("ssh", "truncate --no-create", path)
    config = accessor.config
    timer = start_op()
    sftp = await accessor.sftp()
    remote = join_root(config.root, path.mount_path)
    async with await open_for_write(sftp, remote, path) as f:
        await f.truncate(length)
    record("truncate", path.virtual, "ssh", 0, timer)
    await invalidate_after_write(path)
