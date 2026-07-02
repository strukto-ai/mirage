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

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume._helpers import ensure_path_spec
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.stat import stat
from mirage.observe.context import record
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent


def _delete_file_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> None:
    accessor.files.delete(remote_path)


async def unlink(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> None:
    path = ensure_path_spec(path)
    file_stat = await stat(accessor, path, index)
    if file_stat.type == FileType.DIRECTORY:
        raise IsADirectoryError(path.virtual)
    remote_path = backend_path(accessor.config, path)
    start_ms = int(time.monotonic() * 1000)
    try:
        await asyncio.to_thread(_delete_file_sync, accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("unlink", path.virtual, "databricks_volume", 0, start_ms)
    await invalidate_after_unlink(path)
