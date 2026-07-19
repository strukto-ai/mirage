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
from mirage.core.box.api import create_folder, list_folder_items
from mirage.core.box.resolve import path_parts, resolve_parent_id, root_id
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def _invalidate_levels(path: PathSpec, count: int) -> None:
    # `mkdir -p a/b/c` creates several levels; invalidate each one's parent
    # listing (not just the final target's) so a cached ancestor listing from
    # an earlier command re-fetches and sees the new folders. Box resolves
    # ids through those listings, so a stale ancestor hides new children.
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    segments = path.virtual.rstrip("/").split("/")
    for i in range(count):
        depth = len(segments) - count + i + 1
        level_virtual = "/".join(segments[:depth]) or "/"
        await invalidate_after_write(
            PathSpec.from_str_path(level_virtual,
                                   mount_key(level_virtual, prefix)))


async def mkdir(accessor: BoxAccessor,
                path: PathSpec,
                parents: bool = False) -> None:
    parts = path_parts(path)
    if not parts:
        return
    tm = accessor.token_manager
    if parents:
        cur_id = root_id(accessor)
        for name in parts:
            children = await list_folder_items(tm, cur_id)
            match = next((c for c in children if c["name"] == name), None)
            if match is not None:
                if match.get("type") != "folder":
                    raise NotADirectoryError(path.virtual)
                cur_id = match["id"]
            else:
                created = await create_folder(tm, cur_id, name)
                cur_id = created["id"]
        await _invalidate_levels(path, len(parts))
    else:
        parent_id = await resolve_parent_id(accessor, parts)
        if parent_id is None:
            raise enoent(path.virtual)
        await create_folder(tm, parent_id, parts[-1])
        await invalidate_after_write(path)
