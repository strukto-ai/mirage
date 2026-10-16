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
from mirage.core.gdrive import NATIVE_RESOURCE_TYPES
from mirage.core.gdrive.readdir import live_row, stat_from_item
from mirage.core.gdrive.resolve import eacces_on_denied, parent_folder
from mirage.core.google.drive import update_file_content, upload_file
from mirage.errors.fs import eacces, eisdir
from mirage.observe.context import record, start_op
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.upload import upload_token


@eacces_on_denied
async def write(
    accessor: GDriveAccessor,
    path: PathSpec,
    data: bytes,
    entry: FileStat | None = None,
    parent: FileStat | None = None,
) -> FileStat | None:
    """Upload a new file, or new content for an existing one.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): target path.
        data (bytes): file content.
        entry (FileStat | None): what is at the path.
        parent (FileStat | None): what is at its parent path.

    Returns:
        FileStat | None: the stored file's stat, None for a reply that
            names none.
    """
    virtual = path.virtual
    key = path.vfs_path
    if not key:
        raise eisdir(virtual)
    entry = await live_row(accessor, path, entry)
    timer = start_op()
    token_manager = accessor.token_manager
    if entry is not None and entry.type is FileType.DIRECTORY:
        raise eisdir(virtual)
    # Google-native files are written through the gws commands, not raw
    # bytes; the command chokepoint renders this as "Permission denied".
    if (
        entry is not None
        and entry.extra.get("resource_type") in NATIVE_RESOURCE_TYPES
    ):
        raise eacces(virtual)
    if entry is not None:
        reply = await update_file_content(
            token_manager, entry.extra["file_id"], data
        )
    else:
        parent_id, _ = await parent_folder(accessor, path, parent)
        reply = await upload_file(
            token_manager, posixpath.basename(key), parent_id, data
        )
    token = upload_token(reply, stat_from_item, virtual)
    record("write", virtual, "gdrive", len(data), timer, fingerprint=token)
    return stat_from_item(reply) if isinstance(reply, dict) else None
