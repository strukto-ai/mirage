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

from mirage.accessor.sharepoint import SharePointAccessor
from mirage.core.msgraph.drive import copy_tree
from mirage.core.sharepoint.resolve import drive_loc, resolve_item
from mirage.types import PathSpec


async def copy(
    accessor: SharePointAccessor, src: PathSpec, dst: PathSpec
) -> None:
    """Copy a file or folder server-side, across drives when they differ.

    Args:
        accessor (SharePointAccessor): SharePoint accessor.
        src (PathSpec): the item to copy.
        dst (PathSpec): where the copy lands.
    """
    config = accessor.config
    src_resolved = await resolve_item(accessor, src)
    dst_resolved = await resolve_item(accessor, dst)
    await copy_tree(
        config,
        drive_loc(config, src_resolved, src.vfs_path),
        drive_loc(config, dst_resolved, dst.vfs_path),
        session=accessor.pool,
    )
