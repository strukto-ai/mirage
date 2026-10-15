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
from mirage.errors.fs import enoent
from mirage.types import FileStat, FileType, PathSpec


async def stat(
    accessor: GDriveAccessor, path: PathSpec, entry: FileStat | None = None
) -> FileStat:
    """What is at ``path``: the row its parent's listing named.

    Drive is id-addressed, so a path is only known through the listing
    of the folder holding it, which the mount lists when it holds none.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the path.
        entry (FileStat | None): what is at the path.
    """
    if not path.vfs_path.strip("/"):
        return FileStat(name="/", type=FileType.DIRECTORY)
    if entry is None:
        raise enoent(path.virtual)
    return entry
