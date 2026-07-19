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

import time

from mirage.accessor.box import BoxAccessor
from mirage.cache.context import invalidate_after_write
from mirage.core.box.api import upload_file_version, upload_new_file
from mirage.core.box.resolve import path_parts, resolve_item, resolve_parent_id
from mirage.observe.context import record
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def write_bytes(accessor: BoxAccessor, path: PathSpec,
                      data: bytes) -> None:
    parts = path_parts(path)
    if not parts:
        raise IsADirectoryError(path.virtual)
    tm = accessor.token_manager
    start_ms = int(time.monotonic() * 1000)
    existing = await resolve_item(accessor, parts)
    if existing is not None and existing.get("type") == "file":
        # Overwrite uploads a new version under the same id, keeping Box's
        # own name so a box-native file isn't renamed with the vfs suffix.
        await upload_file_version(tm, existing["id"], existing["name"], data)
    else:
        parent_id = await resolve_parent_id(accessor, parts)
        if parent_id is None:
            raise enoent(path.virtual)
        await upload_new_file(tm, parent_id, parts[-1], data)
    record("write", path.resource_path, "box", len(data), start_ms)
    await invalidate_after_write(path)
