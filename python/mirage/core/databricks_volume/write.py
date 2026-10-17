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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume._helpers import parent_path
from mirage.core.databricks_volume.client import (
    get_directory_metadata,
    get_metadata,
    upload,
)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.errors.fs import enoent, enotdir
from mirage.observe.context import record, start_op
from mirage.types import PathSpec


async def _ensure_parent_directory(
    accessor: DatabricksVolumeAccessor,
    remote_parent: str,
    virtual_target: str,
) -> None:
    try:
        await get_directory_metadata(accessor, remote_parent)
        return
    except Exception as exc:
        if not is_not_found(exc):
            raise
        not_found = exc
    try:
        await get_metadata(accessor, remote_parent)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(virtual_target) from not_found
        raise
    raise enotdir(virtual_target)


async def write(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    data: bytes,
) -> None:
    parent = parent_path(path)
    remote_parent = backend_path(accessor.config, parent)
    remote_path = backend_path(accessor.config, path)
    timer = start_op()
    await _ensure_parent_directory(accessor, remote_parent, path.virtual)
    try:
        await upload(accessor, remote_path, data, overwrite=True)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("write", path.virtual, "databricks_volume", len(data), timer)
