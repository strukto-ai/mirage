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

import logging
import uuid
from typing import Any

from qdrant_client import models
from qdrant_client.http.exceptions import UnexpectedResponse

from mirage.accessor.qdrant import QdrantAccessor

logger = logging.getLogger(__name__)

SCROLL_BATCH = 256


def _coerce(value: str) -> Any:
    if value.lstrip("-").isdigit():
        as_int = int(value)
        if str(as_int) == value:
            return as_int
    return value


def _filter(filters: dict[str, str]) -> models.Filter | None:
    if not filters:
        return None
    return models.Filter(must=[
        models.FieldCondition(key=column,
                              match=models.MatchValue(value=_coerce(value)))
        for column, value in filters.items()
    ])


def _point_to_row(point: Any, id_field: str) -> dict[str, Any]:
    payload = point.payload if isinstance(point.payload, dict) else {}
    row = dict(payload)
    row[id_field] = point.id
    return row


def _candidate_ids(row_id: str) -> list[Any]:
    if row_id.lstrip("-").isdigit():
        return [int(row_id)]
    try:
        uuid.UUID(row_id)
    except ValueError:
        return []
    return [row_id]


async def _scroll_raw(client: Any, collection: str, flt: models.Filter | None,
                      limit: int) -> list[Any]:
    points: list[Any] = []
    offset: Any = None
    while len(points) < limit:
        batch, offset = await client.scroll(
            collection_name=collection,
            scroll_filter=flt,
            limit=min(SCROLL_BATCH, limit - len(points)),
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        points.extend(batch)
        if offset is None:
            break
    return points[:limit]


def _is_index_required(exc: UnexpectedResponse) -> bool:
    content = exc.content
    text = content.decode() if isinstance(content, bytes) else str(content)
    return exc.status_code == 400 and "index required" in text.lower()


async def _ensure_indexes(client: Any, accessor: QdrantAccessor,
                          collection: str) -> None:
    if collection in accessor._indexes_ensured:
        return
    for field in accessor.config.group_by:
        await client.create_payload_index(
            collection_name=collection,
            field_name=field,
            field_schema="keyword",
        )
    accessor._indexes_ensured.add(collection)


async def _scroll_all(accessor: QdrantAccessor, collection: str,
                      filters: dict[str, str], limit: int) -> list[Any]:
    client = await accessor.client()
    if not filters:
        return await _scroll_raw(client, collection, None, limit)
    flt = _filter(filters)
    try:
        return await _scroll_raw(client, collection, flt, limit)
    except UnexpectedResponse as exc:
        if not _is_index_required(exc):
            raise
    await _ensure_indexes(client, accessor, collection)
    return await _scroll_raw(client, collection, flt, limit)


async def list_tables(accessor: QdrantAccessor) -> list[str]:
    client = await accessor.client()
    result = await client.get_collections()
    return sorted(item.name for item in result.collections)


async def table_exists(accessor: QdrantAccessor, name: str) -> bool:
    client = await accessor.client()
    return await client.collection_exists(name)


async def distinct_values(accessor: QdrantAccessor, table: str, column: str,
                          filters: dict[str, str], limit: int) -> list[str]:
    points = await _scroll_all(accessor, table, filters, limit)
    values = {
        str(payload[column])
        for point in points
        if (payload := point.payload or {}).get(column) is not None
    }
    return sorted(values)


async def rows_matching(accessor: QdrantAccessor, table: str,
                        filters: dict[str, str],
                        limit: int) -> list[dict[str, Any]]:
    points = await _scroll_all(accessor, table, filters, limit)
    return [_point_to_row(point, accessor.config.id_field) for point in points]


async def row_record(accessor: QdrantAccessor, table: str, id_field: str,
                     row_id: str) -> dict[str, Any] | None:
    ids = _candidate_ids(row_id)
    if not ids:
        return None
    client = await accessor.client()
    found = await client.retrieve(collection_name=table,
                                  ids=ids,
                                  with_payload=True,
                                  with_vectors=False)
    if not found:
        return None
    return _point_to_row(found[0], id_field)


async def search_rows(accessor: QdrantAccessor, table: str, query_text: str,
                      limit: int) -> list[dict[str, Any]]:
    key = (table, query_text, limit)
    cached = accessor.cached_search(key)
    if cached is not None:
        return cached
    client = await accessor.client()
    response = await client.query_points(
        collection_name=table,
        query=models.Document(text=query_text,
                              model=accessor.config.embedding_model),
        limit=limit,
        with_payload=True,
    )
    rows: list[dict[str, Any]] = []
    for point in response.points:
        row = _point_to_row(point, accessor.config.id_field)
        row["_score"] = point.score
        rows.append(row)
    accessor.store_search(key, rows)
    return rows
