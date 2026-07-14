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

import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.postgres import _client
from mirage.core.postgres._schema_json import (build_database_json,
                                               build_entity_schema_json)
from mirage.core.postgres.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.errors import enoent
from mirage.utils.key_prefix import mount_key, mount_prefix_of


async def read(
    accessor: PostgresAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
    *,
    limit: int | None = None,
    offset: int | None = None,
) -> bytes:
    prefix = mount_prefix_of(path.virtual, path.resource_path)
    raw = path.virtual
    if prefix and raw.startswith(prefix):
        raw = raw[len(prefix):] or "/"
    scope = detect_scope(
        PathSpec(virtual=raw,
                 directory=raw,
                 resource_path=mount_key(raw, prefix)))

    if scope.level == "database_json":
        doc = await build_database_json(accessor)
        return orjson.dumps(doc, option=orjson.OPT_INDENT_2)

    if scope.level == "entity_schema":
        kind = "table" if scope.kind == "tables" else "view"
        doc = await build_entity_schema_json(accessor, scope.schema,
                                             scope.entity, kind)
        return orjson.dumps(doc, option=orjson.OPT_INDENT_2)

    if scope.level == "entity_rows":
        return await _read_rows(accessor,
                                scope.schema,
                                scope.entity,
                                kind=scope.kind,
                                limit=limit,
                                offset=offset)

    raise enoent(path)


async def _read_rows(accessor: PostgresAccessor, schema: str, entity: str, *,
                     kind: str, limit: int | None,
                     offset: int | None) -> bytes:
    cfg = accessor.config
    if limit is None and offset is None:
        pool = await accessor.pool()
        async with pool.acquire() as conn:
            rows, width = await _client.estimate_size(conn, schema, entity)
        if (rows > cfg.max_read_rows
                or rows * max(width, 1) > cfg.max_read_bytes):
            raise ValueError(
                f"{schema}/{kind}/{entity}/rows.jsonl too large to read "
                f"entirely: ~{rows} rows / ~{rows * max(width, 1)} bytes "
                f"(thresholds: {cfg.max_read_rows} rows / "
                f"{cfg.max_read_bytes} bytes); use head, tail, wc, grep, "
                f"or pass limit/offset")
        effective_limit = rows or cfg.default_row_limit
        effective_offset = 0
    else:
        effective_limit = limit if limit is not None else cfg.default_row_limit
        effective_offset = offset or 0

    pool = await accessor.pool()
    async with pool.acquire() as conn:
        data = await _client.fetch_rows(conn,
                                        schema,
                                        entity,
                                        limit=effective_limit,
                                        offset=effective_offset)
    if not data:
        return b""
    lines = [orjson.dumps(r, default=str).decode() for r in data]
    return ("\n".join(lines) + "\n").encode()
