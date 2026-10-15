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

from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.resolve import eacces_on_denied
from mirage.core.google.drive import delete_file, list_files
from mirage.errors.fs import enoent, enotdir, enotempty
from mirage.types import FileStat, FileType, PathSpec


@eacces_on_denied
async def rmdir(
    accessor: GDriveAccessor,
    path: PathSpec,
    entry: FileStat | None = None,
) -> None:
    """Remove an empty folder.

    A Drive ``files.delete`` on a folder removes every descendant with
    it, so this is the same request ``rm_r`` sends and the emptiness
    check is the only thing separating them. Without it ``rmdir``
    destroyed the whole subtree for every caller that does not pre-check
    emptiness itself, and the command builders are the only callers that
    do: FUSE, ``ws.vfs`` and the sandbox runtimes all reach the op
    directly. The probe is the one ``rename`` already makes before it
    overwrites a directory, bounded to a single entry.

    Args:
        accessor (GDriveAccessor): Google Drive accessor.
        path (PathSpec): folder to remove.
        entry (FileStat | None): what is at the path.
    """
    virtual = path.virtual
    if not path.vfs_path:
        return
    if entry is None:
        raise enoent(virtual)
    if entry.type is not FileType.DIRECTORY:
        raise enotdir(virtual)
    children = await list_files(
        accessor.token_manager,
        folder_id=entry.extra["file_id"],
        drive_id=entry.extra.get("drive_id"),
        limit=1,
    )
    if children:
        raise enotempty(path)
    await delete_file(accessor.token_manager, entry.extra["file_id"])
