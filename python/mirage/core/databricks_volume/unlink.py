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
from mirage.core.databricks_volume.client import delete_file
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.stat import stat
from mirage.errors.fs import eisdir, enoent
from mirage.observe.context import record, start_op
from mirage.types import FileType, PathSpec


async def unlink(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
) -> None:
    file_stat = await stat(accessor, path)
    if file_stat.type == FileType.DIRECTORY:
        raise eisdir(path.virtual)
    remote_path = backend_path(accessor.config, path)
    timer = start_op()
    try:
        await delete_file(accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    record("unlink", path.virtual, "databricks_volume", 0, timer)
