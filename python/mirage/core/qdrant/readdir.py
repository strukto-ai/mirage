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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.qdrant.query import (distinct_values, list_tables,
                                      rows_matching)
from mirage.core.qdrant.scope import ScopeLevel, detect_scope
from mirage.types import PathSpec


def is_dir_name(child: str, config) -> bool:
    # Row files are recognized by extension, so classification never needs
    # the stat fallback.
    name = child.rsplit("/", 1)[-1]
    if name.endswith(".json"):
        return False
    if config.text_field and name.endswith(".txt"):
        return False
    if config.blob_field and name.endswith("." + config.blob_ext):
        return False
    return True


def _row_files(rows: list[dict], config) -> list[str]:
    names: list[str] = []
    for row in rows:
        rid = row[config.id_field]
        names.append(f"{rid}.json")
        if config.text_field and row.get(config.text_field) is not None:
            names.append(f"{rid}.txt")
        if config.blob_field and row.get(config.blob_field) is not None:
            names.append(f"{rid}.{config.blob_ext}")
    return names


async def readdir(
    accessor: QdrantAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    config = accessor.config
    scope = detect_scope(path, config)
    base = path.virtual.rstrip("/")

    if scope.level == ScopeLevel.ROOT:
        names = await list_tables(accessor)
        return [f"{base}/{name}" for name in names]

    if scope.level == ScopeLevel.GROUP_DIR:
        assert scope.table is not None
        depth = len(scope.filters)
        total = len(config.group_by)
        if depth < total:
            names = await distinct_values(accessor, scope.table,
                                          config.group_by[depth],
                                          scope.filters, config.max_rows)
        else:
            rows = await rows_matching(accessor, scope.table, scope.filters,
                                       config.max_rows)
            names = _row_files(rows, config)
        return [f"{base}/{name}" for name in names]

    raise FileNotFoundError(path.virtual)
