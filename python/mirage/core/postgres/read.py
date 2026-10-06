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

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import IndexCacheStore
from mirage.core.hierarchy.read import make_read
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres._schema_json import (
    build_database_json,
    build_entity_schema_json,
)
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.semantic import build_entity_semantic_json
from mirage.core.postgres.stat import stat
from mirage.errors.fs import efbig
from mirage.types import PathSpec


def _entity_kind(match: ScopeMatch) -> str:
    return "table" if match.slots["kind"] == "tables" else "view"


async def _read_database_json(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    doc = await build_database_json(accessor)
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_schema(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    doc = await build_entity_schema_json(
        accessor,
        match.slots["schema"],
        match.slots["entity"],
        _entity_kind(match),
    )
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_semantic(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
) -> bytes:
    doc = await build_entity_semantic_json(
        accessor,
        match.slots["schema"],
        match.slots["entity"],
        _entity_kind(match),
    )
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_rows(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    index: IndexCacheStore,
    limit: int | None,
    offset: int | None,
) -> bytes:
    return await read_rows(
        accessor,
        match.slots["schema"],
        match.slots["entity"],
        path=path,
        limit=limit,
        offset=offset,
    )


def row_line(row: dict[str, Any]) -> str:
    """One row as rows.jsonl spells it.

    Args:
        row (dict[str, Any]): a canonicalized row.
    """
    return orjson.dumps(row, default=str).decode()


async def read_rows(
    accessor: PostgresAccessor,
    schema: str,
    entity: str,
    *,
    path: str | PathSpec,
    limit: int | None = None,
    offset: int | None = None,
) -> bytes:
    """Render a relation's rows.jsonl, or the window ``limit``/``offset`` pick.

    The whole file when neither is given, under the size guard: past
    ``max_read_rows`` rows or ``max_read_bytes`` bytes it raises EFBIG,
    which a command reports as ``<cmd>: <path>: File too large`` before
    moving on to its next operand, as for an Airtable table past its cap.

    Args:
        accessor (PostgresAccessor): backend handle.
        schema (str): the owning schema.
        entity (str): the table or view.
        path (str | PathSpec): the rows.jsonl the refusal names.
        limit (int | None): the window's row count.
        offset (int | None): the window's first row.
    """
    cfg = accessor.config
    whole = limit is None and offset is None
    if whole:
        pool = await accessor.pool()
        async with pool.acquire() as conn:
            rows, width = await client.estimate_size(conn, schema, entity)
        if (
            rows > cfg.max_read_rows
            or rows * max(width, 1) > cfg.max_read_bytes
        ):
            raise efbig(path)
        # The estimate only refuses; it never limits. It is planner
        # statistics, which lag the table (a bulk load before the next
        # ANALYZE), so taking it as the LIMIT returned fewer rows than
        # exist, with nothing to say so. One row past the ceiling keeps
        # the read bounded and refuses a table the estimate undercounted
        # on the rows it really has.
        effective_limit = cfg.max_read_rows + 1
        effective_offset = 0
    else:
        effective_limit = limit if limit is not None else cfg.default_row_limit
        effective_offset = offset or 0

    pool = await accessor.pool()
    async with pool.acquire() as conn:
        if whole:
            data = await client.fetch_bounded_rows(
                conn,
                schema,
                entity,
                limit=effective_limit,
                max_bytes=cfg.max_read_bytes,
            )
        else:
            data = await client.fetch_rows(
                conn,
                schema,
                entity,
                limit=effective_limit,
                offset=effective_offset,
            )
    if data is None or whole and len(data) > cfg.max_read_rows:
        raise efbig(path)
    if not data:
        return b""
    body = bytearray()
    for row in data:
        line = (row_line(row) + "\n").encode()
        if whole and len(body) + len(line) > cfg.max_read_bytes:
            raise efbig(path)
        body.extend(line)
    return bytes(body)


read = make_read(
    detect_scope,
    {
        "database_json": _read_database_json,
        "entity_schema": _read_entity_schema,
        "entity_semantic": _read_entity_semantic,
    },
    windowed={"entity_rows": _read_entity_rows},
    stat=stat,
)
