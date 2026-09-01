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
from urllib.parse import quote

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.ranges import range_header, slice_window


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


def _download_bytes_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    window: str | None,
) -> bytes:
    """Download a file, optionally only a byte range of it.

    Args:
        accessor (DatabricksVolumeAccessor): Databricks accessor.
        remote_path (str): path inside the volume.
        window (str | None): an HTTP ``Range`` value, or None for all
            of it.
    """
    if window is None:
        return _read_response_bytes(accessor.files.download(remote_path))
    headers = {
        "Accept": "application/octet-stream",
        "Range": window,
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
    index: IndexCacheStore = NULL_INDEX,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    virtual = path.virtual
    remote_path = backend_path(accessor.config, path)
    timer = start_op()
    if size == 0:
        record("read", virtual, "databricks_volume", 0, timer)
        return b""
    try:
        data = await asyncio.to_thread(
            _download_bytes_sync,
            accessor,
            remote_path,
            range_header(offset, size),
        )
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    # A Range is a request, not an instruction: a gateway may answer with
    # the whole object. The other HTTP backends tell the two apart by the
    # 206, but the SDK hands back a dict of the headers it was asked for
    # and no status, and the Files API answers a honored range with no
    # Content-Range either, so neither proof is available here. A body
    # longer than the window is one, though, and it is the only case that
    # matters: it is the read that returns more bytes than the caller
    # gave room for. A short answer is what EOF looks like and is kept.
    if size is not None and len(data) > size:
        data = slice_window(data, offset, size)
    record("read", virtual, "databricks_volume", len(data), timer)
    return data
