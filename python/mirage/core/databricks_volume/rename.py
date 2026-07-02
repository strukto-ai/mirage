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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.cache.index import IndexCacheStore
from mirage.core.databricks_volume._helpers import ensure_path_spec
from mirage.core.databricks_volume.copy import copy
from mirage.core.databricks_volume.path import backend_path
from mirage.core.databricks_volume.rm import rm_recursive
from mirage.core.databricks_volume.stat import stat
from mirage.core.databricks_volume.unlink import unlink
from mirage.types import FileType, PathSpec


async def rename(
    accessor: DatabricksVolumeAccessor,
    src: PathSpec,
    dst: PathSpec,
    index: IndexCacheStore = None,
) -> None:
    # Non-atomic: the Databricks Files API has no native rename, so this is
    # implemented as copy + delete and can leave partial state on failure.
    src = ensure_path_spec(src)
    dst = ensure_path_spec(dst)
    src_stat = await stat(accessor, src, index)
    remote_src = backend_path(accessor.config, src)
    remote_dst = backend_path(accessor.config, dst)
    if remote_src == remote_dst:
        # rename(2) onto the same path is a no-op; copy + unlink here would
        # upload the file onto itself then delete it, destroying the data.
        # Guard runs after stat so a missing source still raises.
        return
    if src_stat.type == FileType.DIRECTORY:
        if remote_dst.startswith(remote_src + "/"):
            # Moving a directory into its own subtree would run away in the
            # recursive copy and then rm_recursive would delete the original.
            # Refuse before either side effect.
            raise ValueError(
                f"cannot move '{src.virtual}' to a subdirectory of "
                f"itself, '{dst.virtual}'")
        await copy(accessor, src, dst, index, recursive=True)
        await rm_recursive(accessor, src, index)
    else:
        await copy(accessor, src, dst, index)
        await unlink(accessor, src, index)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
