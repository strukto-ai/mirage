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
from urllib.parse import quote

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.onedrive._client import (GraphError, graph_get_bytes,
                                          item_url, split_path)
from mirage.core.onedrive.versions import capture_metadata
from mirage.observe.context import active_recorder, record, revision_for
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _range_header(offset: int, size: int | None) -> str | None:
    if not offset and size is None:
        return None
    end = (offset + size - 1) if size is not None else ""
    return f"bytes={offset}-{end}"


async def read_bytes(accessor: OneDriveAccessor,
                     path: PathSpec,
                     index: IndexCacheStore | None = None,
                     offset: int = 0,
                     size: int | None = None) -> bytes:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    config = accessor.config
    pinned = revision_for(virtual)
    range_header = _range_header(offset, size)
    start_ms = int(time.monotonic() * 1000)
    fingerprint = None
    revision = pinned
    try:
        if pinned:
            action = f"/versions/{quote(pinned, safe='')}/content"
            url = item_url(config, "/" + stripped, action=action)
            data = await graph_get_bytes(config, url, range_header)
        elif active_recorder() is not None:
            fingerprint, revision, download_url = await capture_metadata(
                accessor, path)
            if download_url:
                data = await graph_get_bytes(config,
                                             download_url,
                                             range_header,
                                             auth=False)
            else:
                url = item_url(config, "/" + stripped, action="/content")
                data = await graph_get_bytes(config, url, range_header)
        else:
            url = item_url(config, "/" + stripped, action="/content")
            data = await graph_get_bytes(config, url, range_header)
    except GraphError as exc:
        if exc.status == 404:
            raise enoent(virtual)
        raise
    record("read",
           stripped,
           "onedrive",
           len(data),
           start_ms,
           fingerprint=fingerprint,
           revision=revision)
    return data
