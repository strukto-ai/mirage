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

from mirage.accessor.ssh import SSHAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.ssh._client import _abs
from mirage.observe.context import record
from mirage.types import PathSpec


async def truncate(accessor: SSHAccessor,
                   path: PathSpec,
                   length: int = 0) -> None:
    config = accessor.config
    start_ms = int(time.monotonic() * 1000)
    sftp = await accessor.sftp()
    await sftp.truncate(_abs(config, path.mount_path), length)
    record("truncate", path.mount_path, "ssh", 0, start_ms)
    await invalidate_after_write(path)
