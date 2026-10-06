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
from mirage.core.msgraph.client import GraphError, graph_get
from mirage.core.msgraph.drive import (
    folder_child_count,
    stat_item,
    virtual_key,
)
from mirage.core.onedrive.client import drive_loc
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec


async def stat(
    accessor: OneDriveAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    if not path.vfs_path:
        # The mount root is a real Graph item (`/drive/root` or the
        # key_prefix folder); fetch it so modified is populated instead of
        # synthesizing a bare directory stat. Its `size` is Graph's
        # aggregate subtree storage number, not rendered content length:
        # expose it as extra, like every other folder (see entry_stat).
        try:
            item = await graph_get(
                accessor.config,
                drive_loc(accessor.config, "").item(),
                session=accessor.pool,
            )
        except GraphError as exc:
            if exc.status == 404:
                raise enoent(path)
            raise
        return FileStat(
            name="/",
            type=FileType.DIRECTORY,
            modified=item.get("lastModifiedDateTime"),
            extra={
                "size_bytes": item.get("size"),
                "child_count": folder_child_count(item),
            },
        )
    return await stat_item(
        accessor.config,
        drive_loc(accessor.config, path.vfs_path),
        path.virtual,
        virtual_key(path),
        index,
        session=accessor.pool,
    )
