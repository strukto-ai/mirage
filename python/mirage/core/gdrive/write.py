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
from mirage.core.gdrive.resolve import (eacces_on_denied, resolve_key,
                                        resolve_parent)
from mirage.observe.context import record, start_op
from mirage.types import PathSpec
from mirage.utils.errors import eisdir


@eacces_on_denied
async def write_bytes(accessor: GDriveAccessor, path: PathSpec,
                      data: bytes) -> None:
    virtual = path.virtual
    key = path.resource_path
    if not key:
        raise eisdir(virtual)
    timer = start_op()
    drive = accessor.drive
    node = await resolve_key(accessor, key)
    if node is not None and node.is_folder:
        raise eisdir(virtual)
    # Google-native files are written through the gws commands, not raw
    # bytes; the command chokepoint renders this as "Permission denied".
    if node is not None and node.is_native:
        raise PermissionError(virtual)
    if node is not None:
        await drive.update_file_content(node.id, data)
    else:
        parent_id, _ = await resolve_parent(accessor, path)
        await drive.upload_file(posixpath.basename(key), parent_id, data)
    record("write", key, "gdrive", len(data), timer)
    await invalidate_after_write(path)
