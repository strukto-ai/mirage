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

from mirage.accessor.onedrive import OneDriveAccessor
from mirage.cache.context import invalidate_after_move
from mirage.core.msgraph.drive import rename_replace
from mirage.core.onedrive.client import drive_loc
from mirage.types import PathSpec


async def rename(
    accessor: OneDriveAccessor, src: PathSpec, dst: PathSpec
) -> None:
    config = accessor.config
    result = await rename_replace(
        config,
        drive_loc(config, src.vfs_path),
        drive_loc(config, dst.vfs_path),
        session=accessor.pool,
    )
    # A folder carries a subtree under both names. dst also loses one when
    # the move replaced anything there but a file (an empty folder, or an
    # item of no known kind), whose name may still have cached children.
    # Only a file facet narrows; a reply that names no type keeps the
    # subtree.
    folder = "file" not in result.moved
    await invalidate_after_move(dst, folder or result.replaced_non_file)
    await invalidate_after_move(src, folder)
