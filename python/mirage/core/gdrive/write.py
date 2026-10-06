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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.gdrive.resolve import (
    eacces_on_denied,
    resolve_key,
    resolve_parent,
)
from mirage.core.gdrive.stat import stat_from_item
from mirage.core.google.drive import update_file_content, upload_file
from mirage.errors.fs import eacces, eisdir
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.sizes import upload_receipt


@eacces_on_denied
async def write(accessor: GDriveAccessor, path: PathSpec, data: bytes) -> None:
    virtual = path.virtual
    key = path.vfs_path
    if not key:
        raise eisdir(virtual)
    timer = start_op()
    token_manager = accessor.token_manager
    node = await resolve_key(accessor, key)
    if node is not None and node.is_folder:
        raise eisdir(virtual)
    # Google-native files are written through the gws commands, not raw
    # bytes; the command chokepoint renders this as "Permission denied".
    if node is not None and node.is_native:
        raise eacces(virtual)
    if node is not None:
        item = await update_file_content(token_manager, node.id, data)
    else:
        parent_id, _ = await resolve_parent(accessor, path)
        item = await upload_file(
            token_manager, posixpath.basename(key), parent_id, data
        )
    nbytes, token = upload_receipt(item, stat_from_item, len(data), virtual)
    record("write", virtual, "gdrive", nbytes, timer, fingerprint=token)
    await invalidate_after_write(path)
