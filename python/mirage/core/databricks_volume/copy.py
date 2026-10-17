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
    create_directory,
    download,
    list_directory_contents,
    upload,
)
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.read import read
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.write import write
from mirage.errors.fs import eisdir
from mirage.types import FileType, PathSpec


async def _copy_tree(
    accessor: DatabricksVolumeAccessor,
    remote_src: str,
    remote_dst: str,
) -> None:
    await create_directory(accessor, remote_dst)
    for entry in await list_directory_contents(accessor, remote_src):
        name = entry.path.rstrip("/").rsplit("/", 1)[-1]
        child_dst = remote_dst.rstrip("/") + "/" + name
        if entry.is_directory:
            await _copy_tree(accessor, entry.path, child_dst)
        else:
            await upload(
                accessor,
                child_dst,
                await download(accessor, entry.path),
                overwrite=True,
            )


async def copy(
    accessor: DatabricksVolumeAccessor,
    src: PathSpec,
    dst: PathSpec,
    recursive: bool = False,
) -> None:
    src_stat = await stat(accessor, src)
    # Same-path guard runs after stat (and the non-recursive directory check)
    # so a missing source or `cp` of a directory still raises.
    same_path = backend_path(accessor.config, src) == backend_path(
        accessor.config, dst
    )
    if src_stat.type == FileType.DIRECTORY:
        if not recursive:
            raise eisdir(src.virtual)
        if same_path:
            return
        remote_src = backend_path(accessor.config, src)
        remote_dst = backend_path(accessor.config, dst)
        if remote_dst.startswith(remote_src + "/"):
            # Copying a directory into its own subtree creates the destination
            # inside the source, so the walk would descend into the fresh copy
            # forever. Refuse before any create_directory/upload.
            raise ValueError(
                f"cannot copy a directory, '{src.virtual}', "
                f"into itself, '{dst.virtual}'"
            )
        await _copy_tree(accessor, remote_src, remote_dst)
        return
    if same_path:
        # Copying a file onto itself would re-upload it; skip.
        return
    data = await read(accessor, src)
    await write(accessor, dst, data)
