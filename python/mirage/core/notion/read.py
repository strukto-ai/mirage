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
from mirage.core.notion.normalize import (normalize_database, normalize_page,
                                          to_json_bytes)
from mirage.core.notion.pages import get_database, get_page, list_block_tree
from mirage.core.notion.pathing import split_suffix_id
from mirage.types import PathSpec
from mirage.utils.errors import enoent


async def read_page_json(config, page_id: str) -> bytes:
    page = await get_page(config, page_id)
    blocks = await list_block_tree(config, page_id)
    normalized = normalize_page(page, blocks)
    return to_json_bytes(normalized)


async def read(
    accessor: NotionAccessor,
    path: PathSpec,
    index: IndexCacheStore = None,
) -> bytes:
    virtual = path.virtual
    if isinstance(path, PathSpec):
        path = path.mount_path

    key = path.strip("/")
    parts = key.split("/")

    if not key or key in ("pages", "databases"):
        raise IsADirectoryError(virtual)

    if len(parts) >= 3 and parts[0] == "pages" and parts[-1] == "page.json":
        _, page_id = split_suffix_id(parts[-2])
        return await read_page_json(accessor.config, page_id)

    if (len(parts) == 3 and parts[0] == "databases"
            and parts[-1] == "database.json"):
        _, database_id = split_suffix_id(parts[-2])
        database = await get_database(accessor.config, database_id)
        return to_json_bytes(normalize_database(database))

    if (len(parts) >= 4 and parts[0] == "databases"
            and parts[-1] == "page.json"):
        _, page_id = split_suffix_id(parts[-2])
        return await read_page_json(accessor.config, page_id)

    if (len(parts) >= 2 and parts[0] in ("pages", "databases")
            and not parts[-1].endswith(".json")):
        raise IsADirectoryError(virtual)

    raise enoent(virtual)
