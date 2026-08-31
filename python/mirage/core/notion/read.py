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
from mirage.core.api.client import SessionArg
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.notion.config import NotionConfig
from mirage.core.notion.normalize import (normalize_data_source,
                                          normalize_database, normalize_page,
                                          to_json_bytes)
from mirage.core.notion.pages import (get_data_source, get_database, get_page,
                                      list_block_tree)
from mirage.core.notion.scope import detect_scope
from mirage.types import PathSpec


async def read_page_json(config: NotionConfig,
                         page_id: str,
                         session: SessionArg = None) -> bytes:
    page = await get_page(config, page_id, session=session)
    blocks = await list_block_tree(config, page_id, session=session)
    normalized = normalize_page(page, blocks)
    return to_json_bytes(normalized)


async def _read_page_json(accessor: NotionAccessor, match: ScopeMatch,
                          path: PathSpec, index: IndexCacheStore) -> bytes:
    return await read_page_json(accessor.config,
                                match.slots["page_id"],
                                session=accessor.pool)


async def _read_database_json(accessor: NotionAccessor, match: ScopeMatch,
                              path: PathSpec, index: IndexCacheStore) -> bytes:
    database = await get_database(accessor.config,
                                  match.slots["database_id"],
                                  session=accessor.pool)
    return to_json_bytes(normalize_database(database))


async def _read_data_source_json(accessor: NotionAccessor, match: ScopeMatch,
                                 path: PathSpec,
                                 index: IndexCacheStore) -> bytes:
    data_source = await get_data_source(accessor.config,
                                        match.slots["data_source_id"],
                                        session=accessor.pool)
    return to_json_bytes(normalize_data_source(data_source))


read = make_read(
    detect_scope,
    readers={
        "page_json": _read_page_json,
        "database_json": _read_database_json,
        "data_source_json": _read_data_source_json,
    },
)
