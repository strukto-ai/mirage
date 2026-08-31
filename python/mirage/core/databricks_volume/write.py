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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.context import invalidate_after_write
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume._helpers import parent_path
from mirage.core.databricks_volume.client import DatabricksFilesClient
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def ensure_parent_directory(
    client: DatabricksFilesClient,
    remote_parent: str,
    virtual_target: str,
) -> None:
    """Refuse a write whose parent is missing or is a file.

    A directory answers on /fs/directories and 404s on /fs/files, so
    the two probes tell "no parent" from "parent is a file" apart.

    Args:
        client (DatabricksFilesClient): the Files API client.
        remote_parent (str): the parent's absolute backend path.
        virtual_target (str): the path the caller typed, for the errno.
    """
    try:
        await client.get_directory_metadata(remote_parent)
        return
    except Exception as exc:
        if not is_not_found(exc):
            raise
        not_found = exc
    try:
        await client.get_metadata(remote_parent)
    except Exception as exc:
        if is_not_found(exc):
            raise FileNotFoundError(virtual_target) from not_found
        raise
    raise NotADirectoryError(virtual_target)


async def write_bytes(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    data: bytes,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    parent = parent_path(path)
    remote_parent = backend_path(accessor.config, parent)
    remote_path = backend_path(accessor.config, path)
    start_ms = int(time.monotonic() * 1000)
    await ensure_parent_directory(accessor.client, remote_parent, path.virtual)
    try:
        await accessor.client.upload(remote_path, data)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("write", path.virtual, "databricks_volume", len(data), start_ms)
    await invalidate_after_write(path)
