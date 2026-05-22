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

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.notion.normalize import normalize_page, to_json_bytes
from mirage.core.notion.pages import get_page, list_block_children
from mirage.core.notion.pathing import split_suffix_id
from mirage.types import PathSpec


async def read_page_json(config, page_id: str) -> bytes:
    page = await get_page(config, page_id)
    blocks = await list_block_children(config, page_id)
    normalized = normalize_page(page, blocks)
    return to_json_bytes(normalized)


async def read(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if isinstance(path, PathSpec):
        prefix = path.prefix
        path = path.original
    if prefix and path.startswith(prefix):
        rest = path[len(prefix):]
        if prefix.endswith("/") or rest == "" or rest.startswith("/"):
            path = rest or "/"

    key = path.strip("/")
    parts = key.split("/")

    if not key or key == "pages":
        raise IsADirectoryError(path)

    if len(parts) >= 3 and parts[0] == "pages" and parts[-1] == "page.json":
        _, page_id = split_suffix_id(parts[-2])
        return await read_page_json(accessor.config, page_id)

    if len(parts
           ) >= 2 and parts[0] == "pages" and not parts[-1].endswith(".json"):
        raise IsADirectoryError(path)

    raise FileNotFoundError(path)
