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
from mirage.core.msgraph.drive_ops import (SIMPLE_UPLOAD_MAX,
                                           upload_session_write)
from mirage.core.onedrive._client import graph_put_bytes, item_url, split_path
from mirage.observe.context import record
from mirage.types import PathSpec


async def write_bytes(accessor: OneDriveAccessor, path: PathSpec,
                      data: bytes) -> None:
    prefix, stripped = split_path(path)
    config = accessor.config
    start_ms = int(time.monotonic() * 1000)
    if len(data) <= SIMPLE_UPLOAD_MAX:
        url = item_url(config, "/" + stripped, action="/content")
        await graph_put_bytes(config, url, data)
    else:
        session_url = item_url(config,
                               "/" + stripped,
                               action="/createUploadSession")
        await upload_session_write(config, session_url, data)
    record("write", stripped, "onedrive", len(data), start_ms)
    await invalidate_after_write(path)
