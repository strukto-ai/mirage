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

import asyncio
import time
from urllib.parse import quote

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _read_response_bytes(response) -> bytes:
    if isinstance(response, dict):
        contents = response.get("contents", response)
    else:
        contents = getattr(response, "contents", response)
    if isinstance(contents, bytes):
        return contents
    if hasattr(contents, "read"):
        return contents.read()
    return bytes(contents)


def _range_header(offset: int, size: int | None) -> str | None:
    if offset < 0:
        raise ValueError("offset must be non-negative")
    if size is not None and size < 0:
        raise ValueError("size must be non-negative")
    if offset == 0 and size is None:
        return None
    if size is None:
        return f"bytes={offset}-"
    return f"bytes={offset}-{offset + size - 1}"


def _download_bytes_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    range_header: str | None,
) -> bytes:
    if range_header is None:
        return _read_response_bytes(accessor.files.download(remote_path))
    headers = {
        "Accept": "application/octet-stream",
        "Range": range_header,
    }
    cfg = getattr(accessor.client.api_client, "_cfg", None)
    workspace_id = getattr(cfg, "workspace_id", None)
    if workspace_id:
        headers["X-Databricks-Org-Id"] = workspace_id
    response = accessor.client.api_client.do(
        "GET",
        f"/api/2.0/fs/files{quote(remote_path)}",
        headers=headers,
        response_headers=[
            "content-length",
            "content-range",
            "accept-ranges",
            "content-type",
            "last-modified",
        ],
        raw=True,
    )
    return _read_response_bytes(response)


async def read_bytes(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(virtual=path,
                        directory=path,
                        resource_path=path.strip("/"))
    virtual = path.virtual
    remote_path = backend_path(accessor.config, path)
    start_ms = int(time.monotonic() * 1000)
    if size == 0:
        record("read", virtual, "databricks_volume", 0, start_ms)
        return b""
    try:
        data = await asyncio.to_thread(
            _download_bytes_sync,
            accessor,
            remote_path,
            _range_header(offset, size),
        )
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("read", virtual, "databricks_volume", len(data), start_ms)
    return data
