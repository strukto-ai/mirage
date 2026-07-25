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

import errno
import os
import time

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import invalidate_after_unlink, invalidate_ancestors
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import delete_path, get_metadata, list_folder
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent, enotdir


async def rmdir(accessor: DropboxAccessor, path: PathSpec) -> None:
    """Remove an empty folder.

    delete_v2 removes a folder RECURSIVELY; kernel/GNU rmdir must fail
    ENOTEMPTY on a non-empty dir instead of nuking the subtree (the s3
    backend once had this exact data-loss hazard — do not regress it).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): folder to remove.
    """
    api_path = dropbox_path_of(accessor, path)
    try:
        entry = await get_metadata(accessor.token_manager, api_path)
    except DropboxApiError as exc:
        if exc.status == 409:
            raise enoent(path.virtual) from exc
        raise
    if entry.get(".tag") != "folder":
        raise enotdir(path.virtual)
    children = await list_folder(accessor.token_manager, api_path, limit=1)
    if children:
        raise OSError(errno.ENOTEMPTY, os.strerror(errno.ENOTEMPTY),
                      path.virtual)
    start_ms = int(time.monotonic() * 1000)
    await delete_path(accessor.token_manager, api_path)
    record("rmdir", path.virtual, "dropbox", 0, start_ms)
    await invalidate_after_unlink(path)
    await invalidate_ancestors(path)
