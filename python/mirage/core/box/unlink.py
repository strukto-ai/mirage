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
from mirage.cache.context import invalidate_after_unlink
from mirage.core.box.api import delete_file
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def unlink(accessor: BoxAccessor, path: PathSpec) -> None:
    parts = path_parts(path)
    item = await resolve_item(accessor, parts)
    if item is None:
        raise enoent(path.virtual)
    if item.get("type") == "folder":
        raise IsADirectoryError(path.virtual)
    await delete_file(accessor.token_manager, item["id"])
    await invalidate_after_unlink(path)
