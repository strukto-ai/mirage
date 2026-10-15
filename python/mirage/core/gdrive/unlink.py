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
from mirage.core.google.drive import delete_file
from mirage.errors.fs import eisdir, enoent
from mirage.types import FileStat, FileType, PathSpec


@eacces_on_denied
async def unlink(
    accessor: GDriveAccessor, path: PathSpec, entry: FileStat | None = None
) -> None:
    virtual = path.virtual
    if not path.vfs_path:
        raise eisdir(virtual)
    if entry is None:
        raise enoent(virtual)
    if entry.type is FileType.DIRECTORY:
        raise eisdir(virtual)
    await delete_file(accessor.token_manager, entry.extra["file_id"])
