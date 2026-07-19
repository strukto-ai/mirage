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
from mirage.cache.context import (invalidate_after_unlink,
                                  invalidate_after_write)
from mirage.core.box.api import (delete_file, delete_folder, update_file,
                                 update_folder)
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def rename(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
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
    # GNU mv overwrites the destination; Box 409s on a name clash, so clear
    # an existing dst of the same kind first.
    existing = await resolve_item(accessor, dst_parts)
    if existing is not None and existing["id"] != item["id"]:
        if existing.get("type") == "folder":
            await delete_folder(tm, existing["id"], recursive=True)
        else:
            await delete_file(tm, existing["id"])
    if item.get("type") == "folder":
        await update_folder(tm,
                            item["id"],
                            name=new_name,
                            parent_id=dst_parent)
    else:
        await update_file(tm, item["id"], name=new_name, parent_id=dst_parent)
    await invalidate_after_write(dst)
    await invalidate_after_unlink(src)
