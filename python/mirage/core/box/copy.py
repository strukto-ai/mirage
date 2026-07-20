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

from typing import Any

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.box.api import (copy_file, copy_folder, delete_file,
                                 delete_folder, list_folder_items)
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


def _child_spec(parent: PathSpec, name: str) -> PathSpec:
    prefix = mount_prefix_of(parent.virtual, parent.resource_path)
    virtual = parent.virtual.rstrip("/") + "/" + name
    return PathSpec.from_str_path(virtual, mount_key(virtual, prefix))


async def _copy_into(accessor: BoxAccessor, item: dict[str, Any],
                     dst: PathSpec) -> None:
    tm = accessor.token_manager
    dst_parts = path_parts(dst)
    existing = await resolve_item(accessor, dst_parts)
    if item.get("type") == "folder" and existing is not None and existing.get(
            "type") == "folder":
        # Merge into an existing folder (GNU cp -r semantics): copy each child
        # rather than replacing the folder, so pre-existing entries survive.
        for child in await list_folder_items(tm, item["id"]):
            await _copy_into(accessor, child, _child_spec(dst, child["name"]))
        return
    dst_parent = await resolve_parent_id(accessor, dst_parts)
    if dst_parent is None:
        raise enoent(dst.virtual)
    new_name = dst_parts[-1]
    if existing is not None and existing["id"] != item["id"]:
        if existing.get("type") == "folder":
            await delete_folder(tm, existing["id"], recursive=True)
        else:
            await delete_file(tm, existing["id"])
    if item.get("type") == "folder":
        await copy_folder(tm, item["id"], dst_parent, name=new_name)
    else:
        await copy_file(tm, item["id"], dst_parent, name=new_name)


async def copy(accessor: BoxAccessor, src: PathSpec, dst: PathSpec) -> None:
    item = await resolve_item(accessor, path_parts(src))
    if item is None:
        raise enoent(src.virtual)
    await _copy_into(accessor, item, dst)
    await invalidate_after_write(dst)
