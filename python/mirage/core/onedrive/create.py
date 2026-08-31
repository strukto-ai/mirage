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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.onedrive.client import graph_put_bytes, item_url, split_path
from mirage.observe.context import record
from mirage.types import PathSpec


async def create(accessor: OneDriveAccessor, path: PathSpec) -> None:
    _, stripped = split_path(path)
    start_ms = int(time.monotonic() * 1000)
    url = item_url(accessor.config, "/" + stripped, action="/content")
    await graph_put_bytes(accessor.config, url, b"", session=accessor.pool)
    record("create", stripped, "onedrive", 0, start_ms)
    await invalidate_after_write(path)
