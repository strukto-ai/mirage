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
from mirage.core.gdrive.readdir import stat_from_item
from mirage.core.gdrive.resolve import eacces_on_denied, parent_folder
from mirage.errors.fs import eexist
from mirage.types import FileStat, PathSpec


@eacces_on_denied
async def mkdir(
    accessor: GDriveAccessor,
    path: PathSpec,
    parents: bool = False,
    parent: FileStat | None = None,
) -> FileStat | None:
    """Make one folder inside the folder its parent path names.

    ``mkdir -p`` reaches here one level at a time, each handed the
    level above as its parent.

    Args:
        accessor (GDriveAccessor): Drive accessor.
        path (PathSpec): the folder to make.
        parents (bool): whether the mount root is already enough.
        parent (FileStat | None): what is at the parent path.
    """
    key = path.vfs_path
    if not key:
        if parents:
            return None
        raise eexist(path.virtual)
    parent_id, _ = await parent_folder(accessor, path, parent)
    item = await accessor.drive.create_folder(
        posixpath.basename(key), parent_id
    )
    return stat_from_item(item)
