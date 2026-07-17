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
from mirage.core.onedrive._client import (graph_post, graph_put_bytes,
                                          item_url, split_path, upload_chunk)
from mirage.observe.context import record
from mirage.types import PathSpec

SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024
UPLOAD_CHUNK = 10 * 327680


async def _upload_session(accessor: OneDriveAccessor, stripped: str,
                          data: bytes) -> None:
    config = accessor.config
    session_url = item_url(config,
                           "/" + stripped,
                           action="/createUploadSession")
    # createUploadSession defaults to "fail": without replace, overwriting
    # an existing file 409s on the final chunk.
    session = await graph_post(
        config, session_url,
        {"item": {
            "@microsoft.graph.conflictBehavior": "replace"
        }})
    upload_url = session["uploadUrl"]
    total = len(data)
    start = 0
    while start < total:
        chunk = data[start:start + UPLOAD_CHUNK]
        result = await upload_chunk(config, upload_url, chunk, start, total)
        ranges = result.get("nextExpectedRanges") if result else None
        if ranges:
            start = int(ranges[0].split("-", 1)[0])
        else:
            start += len(chunk)


async def write_bytes(accessor: OneDriveAccessor, path: PathSpec,
                      data: bytes) -> None:
    prefix, stripped = split_path(path)
    config = accessor.config
    start_ms = int(time.monotonic() * 1000)
    if len(data) <= SIMPLE_UPLOAD_MAX:
        url = item_url(config, "/" + stripped, action="/content")
        await graph_put_bytes(config, url, data)
    else:
        await _upload_session(accessor, stripped, data)
    record("write", stripped, "onedrive", len(data), start_ms)
    await invalidate_after_write(path)
