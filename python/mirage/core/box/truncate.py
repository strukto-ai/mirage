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
from mirage.core.box.api import download_file
from mirage.core.box.resolve import path_parts, resolve_item
from mirage.core.box.write import write_bytes
from mirage.types import PathSpec


async def truncate(accessor: BoxAccessor, path: PathSpec, length: int) -> None:
    item = await resolve_item(accessor, path_parts(path))
    data = b""
    if item is not None and item.get("type") == "file":
        data = await download_file(accessor.token_manager, item["id"])
    if length <= len(data):
        new = data[:length]
    else:
        new = data + b"\x00" * (length - len(data))
    await write_bytes(accessor, path, new)
