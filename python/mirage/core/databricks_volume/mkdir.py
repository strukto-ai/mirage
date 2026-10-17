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
from mirage.core.databricks_volume.client import create_directory
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.stat import stat
from mirage.errors.fs import enoent, enotdir
from mirage.types import FileType, PathSpec


async def mkdir(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    parents: bool = False,
) -> None:
    remote_path = backend_path(accessor.config, path)
    if parents:
        await create_directory(accessor, remote_path)
        return
    try:
        parent_stat = await stat(accessor, parent_path(path))
    except FileNotFoundError as exc:
        raise enoent(path) from exc
    if parent_stat.type != FileType.DIRECTORY:
        raise enotdir(path)
    try:
        await create_directory(accessor, remote_path)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
