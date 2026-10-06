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

from mirage.accessor.qdrant import QdrantAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import Reader
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.qdrant.naming import point_id_from_stem, row_stem
from mirage.core.qdrant.payload import field_value
from mirage.core.qdrant.query import row_record
from mirage.core.qdrant.render import render_json, render_text
from mirage.core.vector.read import blob_bytes
from mirage.core.vector.scope import table_of
from mirage.errors.fs import enoent
from mirage.types import PathSpec


async def _row_of(
    accessor: QdrantAccessor, match: ScopeMatch, virtual: str
) -> dict[str, Any]:
    # The label is stripped before the retrieve, so every spelling that
    # ends in __<id> reaches the point; only the stem readdir publishes
    # names it, so an alias reads as absent rather than as the file.
    config = accessor.config
    stem = match.slots["row_id"]
    row = await row_record(
        accessor,
        table_of(config.collection, match),
        config.id_field,
        point_id_from_stem(stem, config),
    )
    if row is None or row_stem(row, config) != stem:
        raise enoent(virtual)
    return row


async def _read_json(
    accessor: QdrantAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    row = await _row_of(accessor, match, path.virtual)
    return render_json(row, accessor.config)


async def _read_text(
    accessor: QdrantAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    config = accessor.config
    row = await _row_of(accessor, match, path.virtual)
    if not config.text_field or field_value(row, config.text_field) is None:
        raise enoent(path)
    return render_text(row, config)


async def _read_blob(
    accessor: QdrantAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    config = accessor.config
    if not config.blob_field:
        raise enoent(path)
    row = await _row_of(accessor, match, path.virtual)
    value = field_value(row, config.blob_field)
    if value is None:
        raise enoent(path)
    return blob_bytes(value)


READERS: dict[str, Reader[QdrantAccessor]] = {
    "row_json": _read_json,
    "row_text": _read_text,
    "row_blob": _read_blob,
}
