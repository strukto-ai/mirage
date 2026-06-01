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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume._helpers import (ensure_path_spec,
                                                    parent_path)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.exists import exists
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.stat import stat
from mirage.types import FileType, PathSpec


def _create_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> None:
    accessor.files.create_directory(remote_path)


async def mkdir(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
    parents: bool = False,
) -> None:
    path = ensure_path_spec(path)
    remote_path = backend_path(accessor.config, path)
    if parents:
        await asyncio.to_thread(_create_directory_sync, accessor, remote_path)
        return
    if await exists(accessor, path):
        raise FileExistsError(path.strip_prefix)
    parent = parent_path(path)
    parent_stat = await stat(accessor, parent, index)
    if parent_stat.type != FileType.DIRECTORY:
        raise NotADirectoryError(path.strip_prefix)
    try:
        await asyncio.to_thread(_create_directory_sync, accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise FileNotFoundError(path.strip_prefix) from exc
        raise
