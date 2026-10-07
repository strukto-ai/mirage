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

from mirage.accessor.dropbox import DropboxAccessor
from mirage.cache.context import (
    evict_after,
    invalidate_after_write,
    invalidate_ancestors,
)
from mirage.core.dropbox.client import dropbox_upload
from mirage.core.dropbox.paths import dropbox_path_of
from mirage.core.dropbox.stat import stat_from_entry
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.upload import upload_token


async def write(
    accessor: DropboxAccessor, path: PathSpec, data: bytes
) -> None:
    """Upload in a single call; Dropbox caps it at ~150 MB (larger files
    need upload sessions, not supported here).

    A failed upload still evicts the path: Dropbox may have stored the
    bytes before its reply broke off.

    Args:
        accessor (DropboxAccessor): Dropbox accessor.
        path (PathSpec): target path.
        data (bytes): file content.
    """
    timer = start_op()

    async def send() -> None:
        entry = await dropbox_upload(
            accessor.token_manager, dropbox_path_of(accessor, path), data
        )
        token = upload_token(entry, stat_from_entry, path.virtual)
        record(
            "write",
            path.virtual,
            "dropbox",
            len(data),
            timer,
            fingerprint=token,
        )

    async def evict(_: None) -> None:
        await invalidate_after_write(path)
        await invalidate_ancestors(path)

    await evict_after(send(), evict)
