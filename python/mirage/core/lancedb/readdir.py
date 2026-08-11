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

from mirage.accessor.lancedb import LanceDBAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.lancedb.query import (distinct_values, list_tables,
                                       rows_matching, table_columns)
from mirage.core.lancedb.render import render_card
from mirage.core.lancedb.scope import (LanceDBGroupScope, ScopeLevel,
                                       detect_scope)
from mirage.types import PathSpec


def _row_files(rows: list[dict[str, Any]], config) -> list[str]:
    names: list[str] = []
    for row in rows:
        rid = row[config.id_column]
        names.append(f"{rid}.md")
        if config.blob_column:
            names.append(f"{rid}.{config.blob_ext}")
    return names


def _row_entries(rows: list[dict[str, Any]],
                 config) -> list[tuple[str, IndexEntry]]:
    # The widened select carries every rendered column, so each card's exact
    # size is free here; blob values are deliberately not fetched at listing
    # time, so blob entries stay size-unknown and stat renders them itself.
    entries: list[tuple[str, IndexEntry]] = []
    for row in rows:
        rid = str(row[config.id_column])
        entries.append((f"{rid}.md",
                        IndexEntry(
                            id=rid,
                            name=f"{rid}.md",
                            resource_type="lancedb/row_card",
                            vfs_name=f"{rid}.md",
                            size=len(render_card(row, config)),
                        )))
        if config.blob_column:
            blob_name = f"{rid}.{config.blob_ext}"
            entries.append((blob_name,
                            IndexEntry(
                                id=rid,
                                name=blob_name,
                                resource_type="lancedb/row_blob",
                                vfs_name=blob_name,
                            )))
    return entries


async def readdir(
    accessor: LanceDBAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    config = accessor.config
    scope = detect_scope(path, config)
    base = path.virtual.rstrip("/")

    if scope.level == ScopeLevel.ROOT:
        names = await list_tables(accessor)
        return [f"{base}/{name}" for name in names]

    if isinstance(scope, LanceDBGroupScope):
        depth = len(scope.filters)
        total = len(config.group_by)
        if depth < total:
            names = await distinct_values(accessor, scope.table,
                                          config.group_by[depth],
                                          scope.filters, config.max_rows)
        else:
            # Select every column except the vector and blob ones (schema
            # order, so the projected rows render byte-identically to the
            # full rows read() fetches). Still one data query; the schema
            # lookup is local metadata on the already-opened table.
            columns = [
                c for c in await table_columns(accessor, scope.table)
                if c != config.vector_column and c != config.blob_column
            ]
            rows = await rows_matching(accessor, scope.table, scope.filters,
                                       columns, config.max_rows)
            names = _row_files(rows, config)
            # find-style callers pass index=None; there is nothing to seed.
            if index is not None:
                await index.set_dir(base, _row_entries(rows, config))
        return [f"{base}/{name}" for name in names]

    raise FileNotFoundError(path.virtual)
