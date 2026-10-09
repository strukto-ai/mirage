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

import json
import logging
import re
import uuid

from qdrant_client import AsyncQdrantClient, models
from qdrant_client.conversions.common_types import PointId
from qdrant_client.http.exceptions import UnexpectedResponse

from mirage.accessor.qdrant import QdrantAccessor
from mirage.core.qdrant.naming import group_name, row_stem
from mirage.core.qdrant.payload import field_value
from mirage.core.qdrant.types import PointTest, QdrantPoint, QdrantRow
from mirage.core.render.json import value_text

logger = logging.getLogger(__name__)

SCROLL_BATCH = 256


def _json_scalar(text: str) -> bool | int | float | None:
    """The non-string JSON scalar a rendered group segment also spells.

    A group value renders through ``value_text``, so a boolean or a number
    lists as its compact JSON and the segment alone cannot say which type
    the payload holds. Only a spelling ``value_text`` would produce counts:
    ``007``, ``-0`` and ``1.50`` are strings and nothing else.

    Args:
        text (str): the decoded group segment.
    """
    try:
        parsed = json.loads(text)
    except ValueError:
        return None
    if isinstance(parsed, bool):
        return parsed
    if isinstance(parsed, (int, float)) and value_text(parsed) == text:
        return parsed
    return None


def _condition(
    column: str, text: str
) -> models.FieldCondition | models.Filter:
    """What one rendered group segment matches in the payload.

    The string itself always, and when the segment also spells a JSON
    scalar, that typed value too, so descending into the ``true`` or
    ``1.5`` directory the listing advertised finds the boolean or float
    points behind it. A number matches as a closed range, which Qdrant
    applies to integer and float payloads alike where ``match`` does not.

    Args:
        column (str): the payload field the group level is named from.
        text (str): the decoded group segment.
    """
    as_text = models.FieldCondition(
        key=column, match=models.MatchValue(value=text)
    )
    scalar = _json_scalar(text)
    if scalar is None:
        return as_text
    if isinstance(scalar, bool):
        typed = models.FieldCondition(
            key=column, match=models.MatchValue(value=scalar)
        )
    else:
        typed = models.FieldCondition(
            key=column, range=models.Range(gte=scalar, lte=scalar)
        )
    return models.Filter(should=[as_text, typed])


def _filter(filters: dict[str, str]) -> models.Filter | None:
    if not filters:
        return None
    return models.Filter(
        must=[_condition(column, value) for column, value in filters.items()]
    )


def _point_to_row(point: QdrantPoint, id_field: str) -> QdrantRow:
    payload = point.payload if isinstance(point.payload, dict) else {}
    row: QdrantRow = dict(payload)
    row[id_field] = (
        str(point.id) if isinstance(point.id, uuid.UUID) else point.id
    )
    return row


def _candidate_ids(row_id: str) -> list[int | str]:
    if re.fullmatch(r"-?[0-9]+", row_id):
        return [int(row_id)]
    try:
        uuid.UUID(row_id)
    except ValueError:
        return []
    return [row_id]


def id_prefix_test(prefix: str) -> PointTest:
    """Keep points whose id starts with a literal name prefix.

    Args:
        prefix (str): the literal prefix a leaf glob asked for.
    """

    def keep(point: QdrantPoint) -> bool:
        return str(point.id).startswith(prefix)

    return keep


def value_prefix_test(
    column: str, prefix: str, basename: bool = False
) -> PointTest:
    """Keep points whose payload value starts with a literal prefix.

    Args:
        column (str): the payload field the group level is named from.
        prefix (str): the literal prefix a group glob asked for.
        basename (bool): compare against the rendered path basename.
    """

    def keep(point: QdrantPoint) -> bool:
        value = field_value(point.payload or {}, column)
        return value is not None and group_name(
            value, basename=basename
        ).startswith(prefix)

    return keep


def exact_name_test(
    column: str, name: str, basename: bool, seen: set[str]
) -> PointTest:
    """Keep the first point of every raw value that renders as one name.

    Args:
        column (str): the payload field the group level is named from.
        name (str): the rendered segment a path spelled.
        basename (bool): compare against the rendered path basename.
        seen (set[str]): raw values already kept, shared across pages.
    """

    def keep(point: QdrantPoint) -> bool:
        value = field_value(point.payload or {}, column)
        if value is None:
            return False
        raw = value_text(value)
        if raw in seen or group_name(raw, basename=basename) != name:
            return False
        seen.add(raw)
        return True

    return keep


async def _scroll_raw(
    client: AsyncQdrantClient,
    collection: str,
    flt: models.Filter | None,
    limit: int,
    keep: PointTest | None = None,
) -> list[models.Record]:
    # Without a test the limit bounds the scroll, which is the ordinary
    # capped listing. With one it bounds the MATCHES, because qdrant has
    # no prefix condition for a point id or a keyword field: the only
    # way to answer a glob for a row past the cap is to keep scrolling
    # and test each page here. A glob is a targeted request, so it pays
    # a scan of the collection where the plain listing pays one page.
    points: list[models.Record] = []
    offset: PointId | None = None
    while len(points) < limit:
        batch, offset = await client.scroll(
            collection_name=collection,
            scroll_filter=flt,
            limit=SCROLL_BATCH
            if keep is not None
            else min(SCROLL_BATCH, limit - len(points)),
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        points.extend(batch if keep is None else [p for p in batch if keep(p)])
        if offset is None:
            break
    return points[:limit]


def _is_index_required(exc: UnexpectedResponse) -> bool:
    content = exc.content
    text = content.decode() if isinstance(content, bytes) else str(content)
    return exc.status_code == 400 and "index required" in text.lower()


async def _ensure_indexes(
    client: AsyncQdrantClient, accessor: QdrantAccessor, collection: str
) -> None:
    if collection in accessor.indexes_ensured:
        return
    for field in accessor.config.group_by:
        await client.create_payload_index(
            collection_name=collection,
            field_name=field,
            field_schema=models.PayloadSchemaType.KEYWORD,
        )
    accessor.indexes_ensured.add(collection)


async def _scroll_all(
    accessor: QdrantAccessor,
    collection: str,
    filters: dict[str, str],
    limit: int,
    keep: PointTest | None = None,
) -> list[models.Record]:
    client = await accessor.client()
    if not filters:
        return await _scroll_raw(client, collection, None, limit, keep)
    flt = _filter(filters)
    try:
        return await _scroll_raw(client, collection, flt, limit, keep)
    except UnexpectedResponse as exc:
        if not _is_index_required(exc):
            raise
    await _ensure_indexes(client, accessor, collection)
    return await _scroll_raw(client, collection, flt, limit, keep)


async def list_tables(accessor: QdrantAccessor) -> list[str]:
    client = await accessor.client()
    result = await client.get_collections()
    return sorted(item.name for item in result.collections)


async def table_exists(accessor: QdrantAccessor, name: str) -> bool:
    client = await accessor.client()
    return await client.collection_exists(name)


async def distinct_values(
    accessor: QdrantAccessor,
    table: str,
    column: str,
    filters: dict[str, str],
    limit: int,
    prefix: str = "",
    basename: bool = False,
) -> list[str]:
    keep = value_prefix_test(column, prefix, basename) if prefix else None
    points = await _scroll_all(accessor, table, filters, limit, keep)
    values = {
        value_text(value)
        for point in points
        if (value := field_value(point.payload or {}, column)) is not None
    }
    return sorted(values)


async def resolve_group(
    accessor: QdrantAccessor,
    table: str,
    column: str,
    filters: dict[str, str],
    name: str,
    basename: bool = False,
) -> list[str]:
    """The raw payload values one rendered group segment stands for.

    A basename drops the value's parents, so two sources can render as
    the same directory. Telling them apart is a question about every
    point under the parent group, not about the first ``max_rows``: the
    scroll runs until it is exhausted or a second distinct value has
    rendered as ``name``, whichever comes first. One value is the
    answer; two is a collision for the caller to refuse.

    Args:
        accessor (QdrantAccessor): the mount's accessor.
        table (str): the collection.
        column (str): the payload field the group level is named from.
        filters (dict[str, str]): the parent groups, already resolved.
        name (str): the rendered segment a path spelled.
        basename (bool): whether the level renders basenames.
    """
    seen: set[str] = set()
    points = await _scroll_all(
        accessor,
        table,
        filters,
        2,
        exact_name_test(column, name, basename, seen),
    )
    return sorted(
        value_text(field_value(point.payload or {}, column))
        for point in points
    )


async def rows_matching(
    accessor: QdrantAccessor,
    table: str,
    filters: dict[str, str],
    limit: int,
    prefix: str = "",
) -> list[QdrantRow]:
    keep: PointTest | None
    if prefix and accessor.config.name_field:

        def keep(point: QdrantPoint) -> bool:
            return row_stem(
                _point_to_row(point, accessor.config.id_field), accessor.config
            ).startswith(prefix)
    else:
        keep = id_prefix_test(prefix) if prefix else None
    points = await _scroll_all(accessor, table, filters, limit, keep)
    return [_point_to_row(point, accessor.config.id_field) for point in points]


async def row_record(
    accessor: QdrantAccessor, table: str, id_field: str, row_id: str
) -> QdrantRow | None:
    ids = _candidate_ids(row_id)
    if not ids:
        return None
    client = await accessor.client()
    found = await client.retrieve(
        collection_name=table, ids=ids, with_payload=True, with_vectors=False
    )
    if not found:
        return None
    return _point_to_row(found[0], id_field)


async def search_rows(
    accessor: QdrantAccessor, table: str, query_text: str, limit: int
) -> list[QdrantRow]:
    key = (table, query_text, limit)
    cached = accessor.search_cache.get(key)
    if cached is not None:
        return cached
    client = await accessor.client()
    response = await client.query_points(
        collection_name=table,
        query=models.Document(
            text=query_text, model=accessor.config.embedding_model
        ),
        limit=limit,
        with_payload=True,
    )
    rows: list[QdrantRow] = []
    for point in response.points:
        row = _point_to_row(point, accessor.config.id_field)
        row["_score"] = point.score
        rows.append(row)
    accessor.search_cache[key] = rows
    return rows
