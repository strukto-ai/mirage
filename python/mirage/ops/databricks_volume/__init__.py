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
from mirage.core.databricks_volume.files import append_bytes, create
from mirage.core.databricks_volume.files import mkdir as mkdir_impl
from mirage.core.databricks_volume.files import read_bytes, readdir
from mirage.core.databricks_volume.files import rename as rename_impl
from mirage.core.databricks_volume.files import rmdir as rmdir_impl
from mirage.core.databricks_volume.files import stat as stat_impl
from mirage.core.databricks_volume.files import truncate as truncate_impl
from mirage.core.databricks_volume.files import unlink as unlink_impl
from mirage.core.databricks_volume.files import write_bytes
from mirage.ops.registry import op
from mirage.types import FileStat, PathSpec


@op("read", resource="databricks_volume")
async def read(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    offset: int = 0,
    size: int | None = None,
    *,
    index,
    **kwargs,
) -> bytes:
    return await read_bytes(accessor, path, index, offset, size)


@op("write", resource="databricks_volume", write=True)
async def write(accessor: DatabricksVolumeAccessor, path: PathSpec,
                data: bytes, **kwargs) -> None:
    await write_bytes(accessor, path, data)


@op("append", resource="databricks_volume", write=True)
async def append(accessor: DatabricksVolumeAccessor, path: PathSpec,
                 data: bytes, **kwargs) -> None:
    await append_bytes(accessor, path, data)


@op("readdir", resource="databricks_volume")
async def list_dir(accessor: DatabricksVolumeAccessor, path: PathSpec, *,
                   index, **kwargs) -> list[str]:
    return await readdir(accessor, path, index)


@op("stat", resource="databricks_volume")
async def stat(accessor: DatabricksVolumeAccessor, path: PathSpec, *, index,
               **kwargs) -> FileStat:
    return await stat_impl(accessor, path, index)


@op("mkdir", resource="databricks_volume", write=True)
async def mkdir(accessor: DatabricksVolumeAccessor, path: PathSpec,
                **kwargs) -> None:
    await mkdir_impl(accessor, path)


@op("unlink", resource="databricks_volume", write=True)
async def unlink(accessor: DatabricksVolumeAccessor, path: PathSpec,
                 **kwargs) -> None:
    await unlink_impl(accessor, path)


@op("rmdir", resource="databricks_volume", write=True)
async def rmdir(accessor: DatabricksVolumeAccessor, path: PathSpec,
                **kwargs) -> None:
    await rmdir_impl(accessor, path)


@op("create", resource="databricks_volume", write=True)
async def create_file(accessor: DatabricksVolumeAccessor, path: PathSpec,
                      **kwargs) -> None:
    await create(accessor, path)


@op("truncate", resource="databricks_volume", write=True)
async def truncate(accessor: DatabricksVolumeAccessor, path: PathSpec,
                   length: int, **kwargs) -> None:
    await truncate_impl(accessor, path, length)


@op("rename", resource="databricks_volume", write=True)
async def rename(accessor: DatabricksVolumeAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    await rename_impl(accessor, src, dst)


OPS = [
    append,
    create_file,
    list_dir,
    mkdir,
    read,
    rename,
    rmdir,
    stat,
    truncate,
    unlink,
    write,
]
