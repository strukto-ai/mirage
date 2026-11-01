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
from mirage.errors.fs import enoent, enotempty
from mirage.types import FileType, PathSpec


async def holds_child(
    accessor: DatabricksVolumeAccessor, remote_dir: str
) -> bool:
    """Whether a directory lists any entry; a missing one holds none.

    Args:
        accessor (DatabricksVolumeAccessor): the volume's client.
        remote_dir (str): the directory's backend path.
    """
    try:
        return bool(await list_directory_contents(accessor, remote_dir))
    except Exception as exc:
        if is_not_found(exc):
            return False
        raise


async def _remove_tree_recurse(
    accessor: DatabricksVolumeAccessor,
    remote_dir: str,
    removed: list[str],
    copied: set[str] | None,
) -> bool:
    left = False
    for entry in await list_directory_contents(accessor, remote_dir):
        if copied is not None and entry.path not in copied:
            left = True
        elif entry.is_directory:
            left = (
                await _remove_tree_recurse(
                    accessor, entry.path, removed, copied
                )
                or left
            )
        else:
            await delete_file(accessor, entry.path)
            removed.append(entry.path)
    if left:
        return True
    try:
        await delete_directory(accessor, remote_dir)
    except Exception as exc:
        # The Files API deletes only an empty directory, so a file written
        # after the listing refuses it.
        if is_not_found(exc) or not await holds_child(accessor, remote_dir):
            raise
        return True
    removed.append(remote_dir)
    return False


async def remove_tree(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    copied: set[str] | None = None,
) -> list[str]:
    """Remove a directory tree, or only what a move copied out of it.

    The walk lists each directory once, so a file written under it since,
    or an entry the move never copied, stays and keeps its directories:
    the tree is ENOTEMPTY.

    Args:
        accessor (DatabricksVolumeAccessor): the volume's client.
        path (PathSpec): the tree's root.
        copied (set[str] | None): the backend paths of the files and
            directories a move copied, the only ones deleted; None deletes
            every entry listed.

    Returns:
        list[str]: the backend paths removed.
    """
    removed: list[str] = []
    try:
        left = await _remove_tree_recurse(
            accessor, backend_path(accessor.config, path), removed, copied
        )
    except Exception as exc:
        if is_not_found(exc):
            raise enoent(path) from exc
        raise
    if left:
        raise enotempty(path)
    return removed


async def rm_recursive(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
) -> list[str]:
    file_stat = await stat(accessor, path)
    if file_stat.type != FileType.DIRECTORY:
        await unlink(accessor, path)
        return [path.mount_path]
    removed = await remove_tree(accessor, path)
    return [virtual_path(accessor.config, backend, "") for backend in removed]
