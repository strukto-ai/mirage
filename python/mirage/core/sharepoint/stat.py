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

import posixpath

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.msgraph.drive import stat_item, virtual_key
from mirage.core.sharepoint.resolve import drive_loc, require_item, resolve
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec


async def stat(
    accessor: SharePointAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    if not path.vfs_path:
        return FileStat(name="/", type=FileType.DIRECTORY)
    resolved = await resolve(accessor, path)
    if resolved.level == "site":
        if resolved.site_id is None:
            raise enoent(path)
        return FileStat(name=path.vfs_path, type=FileType.DIRECTORY)
    if resolved.level == "drive":
        if resolved.drive_id is None:
            raise enoent(path)
        return FileStat(
            name=posixpath.basename(path.vfs_path), type=FileType.DIRECTORY
        )
    require_item(path, resolved)
    return await stat_item(
        accessor.config,
        drive_loc(accessor.config, resolved, path.vfs_path),
        path.virtual,
        virtual_key(path),
        index,
        session=accessor.pool,
    )
