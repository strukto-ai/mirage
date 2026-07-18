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
from mirage.core.gdrive.resolve import (eacces_on_denied, node_from_item,
                                        resolve_key, resolve_parent,
                                        resolve_segment, root_context)
from mirage.core.google.drive import create_folder
from mirage.types import PathSpec


@eacces_on_denied
async def mkdir(accessor: GDriveAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    virtual = path.virtual
    key = path.resource_path
    token_manager = accessor.token_manager
    if not key:
        if parents:
            return
        raise FileExistsError(virtual)
    if not parents:
        node = await resolve_key(accessor, key)
        if node is not None:
            raise FileExistsError(virtual)
        parent_id, _ = await resolve_parent(accessor, path)
        await create_folder(token_manager, posixpath.basename(key), parent_id)
        await invalidate_after_write(path)
        return
    parent_id, drive_id = await root_context(accessor)
    segments = [s for s in key.split("/") if s]
    mount_prefix = virtual[:-len(key)].rstrip("/") if virtual.endswith(
        key) else ""
    for i, segment in enumerate(segments):
        node = await resolve_segment(token_manager,
                                     parent_id,
                                     segment,
                                     drive_id,
                                     at_root=i == 0 and parent_id == "root")
        if node is None:
            item = await create_folder(token_manager, segment, parent_id)
            node = node_from_item(item, drive_id)
            # Every created level makes its parent's cached listing stale,
            # not just the leaf's; a later warm-through resolution of the
            # chain would otherwise ENOENT on the stale ancestor.
            seg_virtual = mount_prefix + "/" + "/".join(segments[:i + 1])
            await invalidate_after_write(PathSpec.from_str_path(seg_virtual))
        elif not node.is_folder:
            # -p only silences EEXIST for directories: a file at the leaf is
            # File exists, a file in the middle is Not a directory.
            if i == len(segments) - 1:
                raise FileExistsError(virtual)
            raise NotADirectoryError(virtual)
        parent_id = node.id
        drive_id = node.drive_id
    await invalidate_after_write(path)
