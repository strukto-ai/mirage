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
from io import BytesIO

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume._helpers import ensure_path_spec
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.read import read_bytes
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.write import write_bytes
from mirage.types import FileType, PathSpec


def _download_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> bytes:
    response = accessor.files.download(remote_path)
    contents = getattr(response, "contents", response)
    if hasattr(contents, "read"):
        return contents.read()
    return bytes(contents)


def _upload_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
    data: bytes,
) -> None:
    accessor.files.upload(remote_path, BytesIO(data), overwrite=True)


def _create_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> None:
    accessor.files.create_directory(remote_path)


def _list_directory_sync(
    accessor: DatabricksVolumeAccessor,
    remote_path: str,
) -> list:
    return list(accessor.files.list_directory_contents(remote_path))


def _copy_tree_sync(
    accessor: DatabricksVolumeAccessor,
    remote_src: str,
    remote_dst: str,
) -> None:
    _create_directory_sync(accessor, remote_dst)
    for entry in _list_directory_sync(accessor, remote_src):
        name = entry.path.rstrip("/").rsplit("/", 1)[-1]
        child_dst = remote_dst.rstrip("/") + "/" + name
        if getattr(entry, "is_directory", False):
            _copy_tree_sync(accessor, entry.path, child_dst)
        else:
            _upload_sync(accessor, child_dst,
                         _download_sync(accessor, entry.path))


async def copy(
    accessor: DatabricksVolumeAccessor,
    src: PathSpec,
    dst: PathSpec,
    index: IndexCacheStore = None,
    recursive: bool = False,
) -> None:
    src = ensure_path_spec(src)
    dst = ensure_path_spec(dst)
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
        await asyncio.to_thread(_copy_tree_sync, accessor, remote_src,
                                remote_dst)
        return
    if same_path:
        # Copying a file onto itself would re-upload it; skip.
        return
    data = await read_bytes(accessor, src, index)
    await write_bytes(accessor, dst, data, index)
