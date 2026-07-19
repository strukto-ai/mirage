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
from mirage.core.gdrive.resolve import (DriveNode, drive_target_name,
                                        eacces_on_denied, node_from_item,
                                        resolve_key, resolve_parent)
from mirage.core.google._client import TokenManager
from mirage.core.google.drive import (FOLDER_MIME, copy_file, create_folder,
                                      delete_file, list_files)
from mirage.types import PathSpec
from mirage.utils.errors import eisdir, enoent


async def copy_children(token_manager: TokenManager, src: DriveNode,
                        dst_folder_id: str) -> None:
    """Recursively copy a folder's children into a destination folder.

    Args:
        token_manager (TokenManager): OAuth2 token manager.
        src (DriveNode): source folder.
        dst_folder_id (str): destination folder id.
    """
    children = await list_files(token_manager,
                                folder_id=src.id,
                                drive_id=src.drive_id)
    for item in children:
        child = node_from_item(item, src.drive_id)
        if child.is_folder:
            created = await create_folder(token_manager, child.name,
                                          dst_folder_id)
            await copy_children(token_manager, child, created["id"])
        else:
            await copy_file(token_manager, child.id, child.name, dst_folder_id)


@eacces_on_denied
async def copy(accessor: GDriveAccessor, src: PathSpec, dst: PathSpec) -> None:
    token_manager = accessor.token_manager
    src_node = await resolve_key(accessor, src.resource_path)
    if src_node is None:
        raise enoent(src.virtual)
    dst_node = await resolve_key(accessor, dst.resource_path)
    if src_node.is_folder:
        if dst_node is not None and not dst_node.is_folder:
            raise NotADirectoryError(dst.virtual)
        if dst_node is None:
            # cp -r merges into an existing directory and creates a missing
            # one, mirroring the msgraph copy_tree.
            dst_parent_id, _ = await resolve_parent(accessor, dst)
            name = posixpath.basename(dst.resource_path)
            created = await create_folder(token_manager, name, dst_parent_id)
            dst_node = DriveNode(id=created["id"],
                                 name=name,
                                 mime_type=FOLDER_MIME,
                                 drive_id=src_node.drive_id)
        await copy_children(token_manager, src_node, dst_node.id)
    else:
        if dst_node is not None and dst_node.is_folder:
            raise eisdir(dst.virtual)
        if dst_node is not None:
            await delete_file(token_manager, dst_node.id)
        dst_parent_id, _ = await resolve_parent(accessor, dst)
        name = drive_target_name(posixpath.basename(dst.resource_path),
                                 src_node)
        await copy_file(token_manager, src_node.id, name, dst_parent_id)
    await invalidate_after_write(dst)
