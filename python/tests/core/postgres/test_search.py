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

from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres.search import (format_grep_results, search_database,
                                         search_entity, search_kind,
                                         search_schema)
from mirage.resource.postgres.config import PostgresConfig


@asynccontextmanager
async def _fake_acquire(conn=None):
    yield conn or MagicMock()


def _accessor(schemas=None) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", schemas=schemas))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


def _accessor_with_conn(conn) -> PostgresAccessor:
    a = PostgresAccessor(PostgresConfig(dsn="postgres://localhost/db"))
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire(conn)
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.mark.asyncio
async def test_search_entity_returns_matching_rows():
    conn = MagicMock()
    conn.fetch = AsyncMock(side_effect=[
        # _text_columns response
        [{
            "column_name": "name"
        }, {
            "column_name": "email"
        }],
        # final query response
        [{
            "id": 1,
            "name": "alice"
        }, {
            "id": 2,
            "name": "alex"
        }],
    ])
    accessor = _accessor_with_conn(conn)
    rows = await search_entity(accessor,
                               "public",
                               "tables",
                               "users",
                               "al",
                               limit=100)
    assert len(rows) == 2
    assert rows[0]["name"] == "alice"


@pytest.mark.asyncio
async def test_search_entity_no_text_columns_returns_empty():
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=[])
    accessor = _accessor_with_conn(conn)
    rows = await search_entity(accessor,
                               "public",
                               "tables",
                               "ints",
                               "x",
                               limit=10)
    assert rows == []


@pytest.mark.asyncio
async def test_search_entity_builds_or_clause():
    conn = MagicMock()
    conn.fetch = AsyncMock(side_effect=[
        [{
            "column_name": "a"
        }, {
            "column_name": "b"
        }, {
            "column_name": "c"
        }],
        [],
    ])
    accessor = _accessor_with_conn(conn)
    await search_entity(accessor, "public", "tables", "t1", "pat", limit=5)
    final_call_sql = conn.fetch.await_args_list[1].args[0]
    # grep is case-sensitive by default, so the push-down uses LIKE, not ILIKE.
    assert "ILIKE" not in final_call_sql
    assert final_call_sql.count("LIKE") == 3
    assert "$1" in final_call_sql
    assert "LIMIT $2" in final_call_sql


@pytest.mark.asyncio
async def test_search_entity_case_insensitive_uses_ilike_and_escapes():
    conn = MagicMock()
    conn.fetch = AsyncMock(side_effect=[[{"column_name": "a"}], []])
    accessor = _accessor_with_conn(conn)
    await search_entity(accessor,
                        "public",
                        "tables",
                        "t1",
                        "user_id",
                        limit=5,
                        case_insensitive=True)
    final_call_sql = conn.fetch.await_args_list[1].args[0]
    assert "ILIKE" in final_call_sql
    # `_` is escaped so it matches literally, not as a LIKE wildcard.
    assert conn.fetch.await_args_list[1].args[1] == "%user\\_id%"


@pytest.mark.asyncio
async def test_search_kind_iterates_tables():
    accessor = _accessor()
    with patch("mirage.core.postgres.search._client") as mc, \
         patch("mirage.core.postgres.search.search_entity",
               new_callable=AsyncMock) as mock_entity:
        mc.list_tables = AsyncMock(return_value=["t1", "t2", "t3"])
        mock_entity.side_effect = [
            [{
                "id": 1
            }],  # t1 has matches
            [],  # t2 empty
            [{
                "id": 9
            }],  # t3 has matches
        ]
        result = await search_kind(accessor, "public", "tables", "x", limit=10)
    assert len(result) == 2
    assert result[0] == ("public", "tables", "t1", [{"id": 1}])
    assert result[1] == ("public", "tables", "t3", [{"id": 9}])


@pytest.mark.asyncio
async def test_search_kind_views_unions_views_and_matviews():
    accessor = _accessor()
    with patch("mirage.core.postgres.search._client") as mc, \
         patch("mirage.core.postgres.search.search_entity",
               new_callable=AsyncMock, return_value=[]) as mock_entity:
        mc.list_views = AsyncMock(return_value=["v1"])
        mc.list_matviews = AsyncMock(return_value=["mv1"])
        await search_kind(accessor, "public", "views", "x", limit=10)
    called_entities = sorted(c.args[3] for c in mock_entity.await_args_list)
    assert called_entities == ["mv1", "v1"]


@pytest.mark.asyncio
async def test_search_schema_visits_both_kinds():
    accessor = _accessor()
    with patch("mirage.core.postgres.search.search_kind",
               new_callable=AsyncMock,
               side_effect=[
                   [("public", "tables", "t1", [{
                       "id": 1
                   }])],
                   [("public", "views", "v1", [{
                       "id": 2
                   }])],
               ]) as mock_kind:
        result = await search_schema(accessor, "public", "x", limit=10)
    assert len(result) == 2
    assert mock_kind.await_args_list[0].args == (accessor, "public", "tables",
                                                 "x", 10)
    assert mock_kind.await_args_list[1].args == (accessor, "public", "views",
                                                 "x", 10)


@pytest.mark.asyncio
async def test_search_database_iterates_schemas():
    accessor = _accessor()
    with patch("mirage.core.postgres.search._client") as mc, \
         patch("mirage.core.postgres.search.search_schema",
               new_callable=AsyncMock,
               side_effect=[
                   [("public", "tables", "t1", [{"id": 1}])],
                   [("analytics", "tables", "t2", [{"id": 2}])],
               ]) as mock_schema:
        mc.list_schemas = AsyncMock(return_value=["public", "analytics"])
        result = await search_database(accessor, "x", limit=10)
    assert len(result) == 2
    assert mock_schema.await_count == 2


def test_format_grep_results():
    results = [
        ("public", "tables", "users", [{
            "id": 1,
            "name": "a"
        }]),
        ("public", "views", "v1", [{
            "x": 9
        }]),
    ]
    lines = format_grep_results(results)
    assert len(lines) == 2
    assert lines[0].startswith("public/tables/users/rows.jsonl:")
    assert "{\"id\":1,\"name\":\"a\"}" in lines[0]
    assert lines[1].startswith("public/views/v1/rows.jsonl:")


def test_format_grep_results_empty():
    assert format_grep_results([]) == []


def test_format_grep_results_multiple_rows_per_entity():
    results = [
        ("s", "tables", "t", [{
            "x": 1
        }, {
            "x": 2
        }, {
            "x": 3
        }]),
    ]
    lines = format_grep_results(results)
    assert len(lines) == 3
