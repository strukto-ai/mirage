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
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.ssh._client import _abs
from mirage.types import PathSpec


async def mkdir(accessor: SSHAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    config = accessor.config
    sftp = await accessor.sftp()
    if parents:
        await sftp.makedirs(_abs(config, path.mount_path), exist_ok=True)
    else:
        await sftp.mkdir(_abs(config, path.mount_path))
    await invalidate_after_write(path)
    if parents:
        await invalidate_ancestors(path)
