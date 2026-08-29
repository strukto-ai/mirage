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
from mirage.cache.context import invalidate_subtree
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume.client import DatabricksFilesClient
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.unlink import unlink
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent


async def remove_tree(
    client: DatabricksFilesClient,
    remote_dir: str,
    removed: list[str],
) -> None:
    """Delete a directory bottom-up, recording every path removed.

    Args:
        client (DatabricksFilesClient): the Files API client.
        remote_dir (str): absolute backend path of the directory.
        removed (list[str]): accumulates the paths deleted, in order.
    """
    for entry in await client.list_directory(remote_dir):
        if entry.is_directory:
            await remove_tree(client, entry.path, removed)
        else:
            await client.delete(entry.path)
            removed.append(entry.path)
    await client.delete_directory(remote_dir)
    removed.append(remote_dir)


async def rm_recursive(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    file_stat = await stat(accessor, path, index)
    if file_stat.type != FileType.DIRECTORY:
        await unlink(accessor, path, index)
        return [path.mount_path]
    remote_root = backend_path(accessor.config, path)
    removed: list[str] = []
    try:
        await remove_tree(accessor.client, remote_root, removed)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    await invalidate_subtree(path)
    return [virtual_path(accessor.config, backend, "") for backend in removed]
