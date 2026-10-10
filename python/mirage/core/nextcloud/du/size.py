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

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.nextcloud.du.walk import stat_or_null
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import raw_path_of


async def size(
    accessor: NextcloudAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> int:
    """Recursive byte size of everything under a path.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): target path.
    """
    info = await stat_or_null(accessor, path, index=index)
    if info is not None and info.type != FileType.DIRECTORY:
        return info.size or 0
    pfx = raw_path_of(path).strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            if entry.path.endswith("/"):
                continue
            meta = entry.metadata
            if meta is not None:
                total += int(meta.content_length or 0)
    except NotFound:
        return 0
    return total
