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
from mirage.cache.context import invalidate_after_unlink, invalidate_ancestors
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.databricks_volume.client import DatabricksFilesClient
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.read import read_bytes
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.write import write_bytes
from mirage.types import FileType, PathSpec


async def copy_tree(
    client: DatabricksFilesClient,
    remote_src: str,
    remote_dst: str,
) -> None:
    """Recreate a directory subtree under a new backend path.

    Args:
        client (DatabricksFilesClient): the Files API client.
        remote_src (str): absolute backend path of the source directory.
        remote_dst (str): absolute backend path of the destination.
    """
    await client.create_directory(remote_dst)
    for entry in await client.list_directory(remote_src):
        name = entry.path.rstrip("/").rsplit("/", 1)[-1]
        child_dst = remote_dst.rstrip("/") + "/" + name
        if entry.is_directory:
            await copy_tree(client, entry.path, child_dst)
        else:
            await client.upload(child_dst, await client.download(entry.path))


async def copy(
    accessor: DatabricksVolumeAccessor,
    src: PathSpec,
    dst: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    recursive: bool = False,
) -> None:
    src_stat = await stat(accessor, src, index)
    # Same-path guard runs after stat (and the non-recursive directory check)
    # so a missing source or `cp` of a directory still raises.
    same_path = backend_path(accessor.config,
                             src) == backend_path(accessor.config, dst)
    if src_stat.type == FileType.DIRECTORY:
        if not recursive:
            raise IsADirectoryError(src.virtual)
        if same_path:
            return
        remote_src = backend_path(accessor.config, src)
        remote_dst = backend_path(accessor.config, dst)
        if remote_dst.startswith(remote_src + "/"):
            # Copying a directory into its own subtree creates the destination
            # inside the source, so the walk would descend into the fresh copy
            # forever. Refuse before any create_directory/upload.
            raise ValueError(f"cannot copy a directory, '{src.virtual}', "
                             f"into itself, '{dst.virtual}'")
        await copy_tree(accessor.client, remote_src, remote_dst)
        # create_directory materializes missing ancestors and the walk can
        # merge into a pre-existing destination directory (mv onto an empty
        # dir), so evict the destination's own listing and every ancestor
        # listing, not just the parent (mirrors mkdir with parents=True).
        await invalidate_after_unlink(dst)
        await invalidate_ancestors(dst)
        return
    if same_path:
        # Copying a file onto itself would re-upload it; skip.
        return
    data = await read_bytes(accessor, src, index)
    await write_bytes(accessor, dst, data, index)
