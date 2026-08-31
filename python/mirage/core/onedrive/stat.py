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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive_ops import folder_child_count, stat_item
from mirage.core.onedrive.client import (GraphError, drive_loc, graph_get,
                                         split_path)
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


async def stat(accessor: OneDriveAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    virtual = path.virtual if isinstance(path, PathSpec) else path
    prefix, stripped = split_path(path)
    if not stripped:
        # The mount root is a real Graph item (`/drive/root` or the
        # key_prefix folder); fetch it so size/modified are populated
        # instead of synthesizing a bare directory stat.
        try:
            item = await graph_get(accessor.config,
                                   drive_loc(accessor.config, "").item(),
                                   session=accessor.pool)
        except GraphError as exc:
            if exc.status == 404:
                raise enoent(virtual)
            raise
        # The root's `size` is Graph's aggregate subtree storage number,
        # not rendered content length: expose it as extra, like every
        # other folder (see entry_stat).
        return FileStat(name="/",
                        type=FileType.DIRECTORY,
                        modified=item.get("lastModifiedDateTime"),
                        extra={
                            "size_bytes": item.get("size"),
                            "child_count": folder_child_count(item),
                        })
    virtual_key = (prefix + "/" + stripped if prefix else "/" + stripped)
    return await stat_item(accessor.config,
                           drive_loc(accessor.config, stripped),
                           virtual,
                           virtual_key,
                           index,
                           session=accessor.pool)
