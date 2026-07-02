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
from mirage.cache.context import invalidate_after_unlink
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume._helpers import ensure_path_spec
from mirage.core.databricks_volume.errors import is_not_found
from mirage.core.databricks_volume.path import backend_path, virtual_path
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.unlink import unlink
from mirage.types import FileType, PathSpec
from mirage.utils.errors import enoent


def _list_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> list:
    return list(accessor.files.list_directory_contents(remote_path))


def _delete_file_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> None:
    accessor.files.delete(remote_path)


def _delete_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> None:
    accessor.files.delete_directory(remote_path)


def _remove_tree_recurse(
    accessor: DatabricksVolumeAccessor,
    remote_dir: str,
    removed: list[str],
) -> None:
    for entry in _list_directory_sync(accessor, remote_dir):
        if getattr(entry, "is_directory", False):
            _remove_tree_recurse(accessor, entry.path, removed)
        else:
            _delete_file_sync(accessor, entry.path)
            removed.append(entry.path)
    _delete_directory_sync(accessor, remote_dir)
    removed.append(remote_dir)


def _remove_tree_sync(
    accessor: DatabricksVolumeAccessor,
    remote_root: str,
) -> list[str]:
    removed: list[str] = []
    _remove_tree_recurse(accessor, remote_root, removed)
    return removed


async def rm_recursive(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> list[str]:
    path = ensure_path_spec(path)
    file_stat = await stat(accessor, path, index)
    if file_stat.type != FileType.DIRECTORY:
        await unlink(accessor, path, index)
        return [path.mount_path]
    remote_root = backend_path(accessor.config, path)
    try:
        removed = await asyncio.to_thread(_remove_tree_sync, accessor,
                                          remote_root)
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    await invalidate_after_unlink(path)
    return [virtual_path(accessor.config, backend, "") for backend in removed]
