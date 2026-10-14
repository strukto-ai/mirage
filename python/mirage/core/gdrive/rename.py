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
from mirage.core.gdrive.resolve import (
    drive_target_name,
    eacces_on_denied,
    resolve_key,
    resolve_parent,
)
from mirage.core.google.drive import (
    delete_file,
    get_file,
    list_files,
    patch_file,
)
from mirage.errors.fs import enoent, enotempty
from mirage.types import PathSpec


@eacces_on_denied
async def rename(
    accessor: GDriveAccessor, src: PathSpec, dst: PathSpec
) -> None:
    token_manager = accessor.token_manager
    src_node = await resolve_key(accessor, src.vfs_path)
    if src_node is None:
        raise enoent(src.virtual)
    dst_node = await resolve_key(accessor, dst.vfs_path)
    if dst_node is not None:
        # GNU mv overwrites the destination: drop a conflicting file (or
        # empty folder) before the move. A non-empty folder conflict is mv's
        # "Directory not empty", mirroring the msgraph rename_replace.
        if dst_node.is_folder:
            children = await list_files(
                token_manager,
                folder_id=dst_node.id,
                drive_id=dst_node.drive_id,
                limit=1,
            )
            if children:
                raise enotempty(dst)
        await delete_file(token_manager, dst_node.id)
    src_parent_id, _ = await resolve_parent(accessor, src)
    dst_parent_id, _ = await resolve_parent(accessor, dst)
    name = drive_target_name(posixpath.basename(dst.vfs_path), src_node)
    add_parents = dst_parent_id if dst_parent_id != src_parent_id else None
    remove_parents = src_parent_id if add_parents else None
    # Drive stamps a rename as an edit, so the time goes back as rename(2)
    # keeps it. Drive has no conditional update; reading it just before
    # leaves one request for another writer's edit to land in.
    body = {"name": name}
    modified = (await get_file(token_manager, src_node.id)).get("modifiedTime")
    if modified:
        body["modifiedTime"] = modified
    await patch_file(
        token_manager,
        src_node.id,
        body,
        add_parents=add_parents,
        remove_parents=remove_parents,
    )
