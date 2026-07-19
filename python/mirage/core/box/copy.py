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
from mirage.cache.context import invalidate_after_write
from mirage.core.box.api import (copy_file, copy_folder, delete_file,
                                 delete_folder)
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    tm = accessor.token_manager
    src_parts = path_parts(src)
    dst_parts = path_parts(dst)
    item = await resolve_item(accessor, src_parts)
    if item is None:
        raise enoent(src.virtual)
    dst_parent = await resolve_parent_id(accessor, dst_parts)
    if dst_parent is None:
        raise enoent(dst.virtual)
    new_name = dst_parts[-1]
    # GNU cp overwrites; Box 409s on a name clash under the same parent.
    existing = await resolve_item(accessor, dst_parts)
    if existing is not None and existing["id"] != item["id"]:
        if existing.get("type") == "folder":
            await delete_folder(tm, existing["id"], recursive=True)
        else:
            await delete_file(tm, existing["id"])
    if item.get("type") == "folder":
        await copy_folder(tm, item["id"], dst_parent, name=new_name)
    else:
        await copy_file(tm, item["id"], dst_parent, name=new_name)
    await invalidate_after_write(dst)
