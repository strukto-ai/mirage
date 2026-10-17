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
from mirage.core.databricks_volume.client import (
    delete_directory,
    delete_file,
    list_directory_contents,
)
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.unlink import unlink
from mirage.errors.fs import enoent
from mirage.types import FileType, PathSpec


async def _remove_tree_recurse(
    accessor: DatabricksVolumeAccessor,
    remote_dir: str,
    removed: list[str],
) -> None:
    for entry in await list_directory_contents(accessor, remote_dir):
        if entry.is_directory:
            await _remove_tree_recurse(accessor, entry.path, removed)
        else:
            await delete_file(accessor, entry.path)
            removed.append(entry.path)
    await delete_directory(accessor, remote_dir)
    removed.append(remote_dir)


async def _remove_tree(
    accessor: DatabricksVolumeAccessor,
    remote_root: str,
) -> list[str]:
    removed: list[str] = []
    await _remove_tree_recurse(accessor, remote_root, removed)
    return removed


async def rm_recursive(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
) -> list[str]:
    file_stat = await stat(accessor, path)
    if file_stat.type != FileType.DIRECTORY:
        await unlink(accessor, path)
        return [path.mount_path]
    remote_root = backend_path(accessor.config, path)
    try:
        removed = await _remove_tree(accessor, remote_root)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    return [virtual_path(accessor.config, backend, "") for backend in removed]
