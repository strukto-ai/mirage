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

from mirage.accessor.box import BoxAccessor
from mirage.core.box.api import create_folder
from mirage.core.box.client import BoxApiError
from mirage.core.box.readdir import stat_from_item
from mirage.core.box.resolve import parent_folder, path_parts
from mirage.errors.fs import eexist
from mirage.types import FileStat, PathSpec
from mirage.utils.upload import upload_stat


async def mkdir(
    accessor: BoxAccessor,
    path: PathSpec,
    parents: bool = False,
    parent: FileStat | None = None,
) -> FileStat | None:
    """Make one folder inside the folder its parent path names.

    ``mkdir -p`` reaches here one level at a time, each handed the
    level above as its parent.

    Args:
        accessor (BoxAccessor): Box accessor.
        path (PathSpec): the folder to make.
        parents (bool): whether the mount root is already enough.
        parent (FileStat | None): what is at the parent path.
    """
    parts = path_parts(path)
    if not parts:
        if parents:
            return None
        raise eexist(path.virtual)
    folder_id = parent_folder(accessor, path, parent)
    # Box 409s a name already taken, by a file or a folder: EEXIST, named
    # here because BoxApiError carries no errno.
    try:
        created = await create_folder(
            accessor.token_manager, folder_id, parts[-1]
        )
    except BoxApiError as exc:
        if exc.status == 409:
            raise eexist(path) from exc
        raise
    return upload_stat(created, stat_from_item, path.virtual)
