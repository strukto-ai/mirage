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

from collections.abc import AsyncIterator
from urllib.parse import quote

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.onedrive._client import (GraphError, graph_stream, item_url,
                                          split_path)
from mirage.core.onedrive.read import read_bytes
from mirage.core.onedrive.versions import capture_metadata
from mirage.observe.context import record_stream, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_stream(
    accessor: OneDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    chunk_size: int = 8192,
) -> AsyncIterator[bytes]:
    virtual = path.original if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    config = accessor.config
    pinned = revision_for(virtual)
    rec = record_stream("read", stripped, "onedrive")
    url = item_url(config, "/" + stripped, action="/content")
    auth = True
    try:
        if pinned is not None:
            action = f"/versions/{quote(pinned, safe='')}/content"
            url = item_url(config, "/" + stripped, action=action)
            if rec is not None:
                rec.revision = pinned
        elif rec is not None:
            (rec.fingerprint, rec.revision,
             download_url) = await capture_metadata(accessor, path)
            if download_url:
                url = download_url
                auth = False
        async for chunk in graph_stream(config, url, chunk_size, auth=auth):
            if rec is not None:
                rec.bytes += len(chunk)
            yield chunk
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise


async def range_read(accessor: OneDriveAccessor, path: PathSpec, start: int,
                     end: int) -> bytes:
    return await read_bytes(accessor, path, offset=start, size=end - start)
