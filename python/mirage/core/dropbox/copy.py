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

import time

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import invalidate_after_write, invalidate_ancestors
from mirage.core.dropbox._client import DropboxApiError
from mirage.core.dropbox.api import copy_path, delete_path, get_metadata
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def copy(accessor: DropboxAccessor, src: PathSpec,
               dst: PathSpec) -> None:
    """copy_v2 copies files and folder subtrees server-side; an existing
    destination FILE is replaced like GNU cp (delete + retry).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        src (PathSpec): source path.
        dst (PathSpec): destination path.
    """
    from_path = dropbox_path_of(accessor, src)
    to_path = dropbox_path_of(accessor, dst)
    start_ms = int(time.monotonic() * 1000)
    try:
        await copy_path(accessor.token_manager, from_path, to_path)
    except DropboxApiError as exc:
        if exc.summary.startswith("from_lookup/not_found"):
            raise enoent(src.virtual) from exc
        if not exc.summary.startswith("to/conflict"):
            raise
        existing = await get_metadata(accessor.token_manager, to_path)
        if existing.get(".tag") == "folder":
            raise
        await delete_path(accessor.token_manager, to_path)
        await copy_path(accessor.token_manager, from_path, to_path)
    record("copy", src.virtual, "dropbox", 0, start_ms)
    await invalidate_after_write(dst)
    await invalidate_ancestors(dst)
