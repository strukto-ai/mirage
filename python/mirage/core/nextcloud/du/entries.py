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

import logging

from opendal.exceptions import NotFound

from mirage.accessor.nextcloud import NextcloudAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.nextcloud.stat import stat
from mirage.types import FileType, PathSpec

logger = logging.getLogger(__name__)


async def entries(
        accessor: NextcloudAccessor,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX
) -> tuple[list[tuple[str, int]], int]:
    """Per-file sizes under a path plus their total.

    Args:
        accessor (NextcloudAccessor): Nextcloud accessor.
        path (PathSpec): target path.
    """
    try:
        info = await stat(accessor, path, index=index)
    except FileNotFoundError:
        info = None
    if info is not None and info.type != FileType.DIRECTORY:
        return [], info.size or 0
    pfx = path.mount_path.strip("/")
    scan_path = pfx + "/" if pfx else "/"
    op = accessor.operator()
    found: list[tuple[str, int]] = []
    total = 0
    try:
        async for entry in await op.scan(scan_path):
            rel = entry.path
            if not rel or rel.endswith("/"):
                continue
            meta = entry.metadata
            size = int(meta.content_length or 0) if meta is not None else 0
            found.append(("/" + rel.lstrip("/"), size))
            total += size
    except NotFound:
        logger.debug("nextcloud du: listing raced a delete under %s",
                     scan_path)
    found.sort()
    return found, total
