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
from mirage.cache.context import invalidate_after_write
from mirage.core.dropbox._client import dropbox_upload
from mirage.core.dropbox.invalidate import invalidate_ancestors
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.observe.context import record
from mirage.types import PathSpec


async def write_bytes(accessor: DropboxAccessor, path: PathSpec,
                      data: bytes) -> None:
    """Upload in a single call; Dropbox caps it at ~150 MB (larger files
    need upload sessions, not supported here).

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): target path.
        data (bytes): file content.
    """
    start_ms = int(time.monotonic() * 1000)
    await dropbox_upload(accessor.token_manager,
                         dropbox_path_of(accessor, path), data)
    record("write", path.virtual, "dropbox", len(data), start_ms)
    await invalidate_after_write(path)
    await invalidate_ancestors(path)
