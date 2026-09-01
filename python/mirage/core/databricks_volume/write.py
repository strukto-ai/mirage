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
from io import BytesIO

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.context import invalidate_after_write
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume._helpers import (is_directory_metadata,
                                                    parent_path)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import enoent


def _ensure_parent_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_parent: str,
    virtual_target: str,
) -> None:
    try:
        accessor.files.get_directory_metadata(remote_parent)
        return
    except Exception as exc:
        if not is_not_found(exc):
            raise
        not_found = exc
    try:
        metadata = accessor.files.get_metadata(remote_parent)
    except Exception as exc:
        if is_not_found(exc):
            raise FileNotFoundError(virtual_target) from not_found
        raise
    if not is_directory_metadata(metadata):
        raise NotADirectoryError(virtual_target)


def _upload_bytes_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    data: bytes,
) -> None:
    accessor.files.upload(remote_path, BytesIO(data), overwrite=True)


async def write_bytes(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    data: bytes,
    index: IndexCacheStore = NULL_INDEX,
) -> None:
    parent = parent_path(path)
    remote_parent = backend_path(accessor.config, parent)
    remote_path = backend_path(accessor.config, path)
    timer = start_op()
    # TODO native async client calling HTTP API as databricks sdk is sync
    await asyncio.to_thread(
        _ensure_parent_directory_sync,
        accessor,
        remote_parent,
        path.virtual,
    )
    try:
        await asyncio.to_thread(_upload_bytes_sync, accessor, remote_path,
                                data)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("write", path.virtual, "databricks_volume", len(data), timer)
    await invalidate_after_write(path)
