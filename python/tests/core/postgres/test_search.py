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
from mirage.core.postgres.search import (
    format_grep_results,
    search_database,
    search_entity,
    search_kind,
    search_schema,
)
from mirage.errors.types import FileTooLargeError
from mirage.vfs.postgres.config import PostgresConfig
from mirage.vfs.types import SearchQuery


@asynccontextmanager
async def _fake_acquire(conn=None):
    yield conn or MagicMock()


def _accessor(schemas=None) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", schemas=schemas)
    )
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


def _columns(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    # What `client.fetch_columns` reads off information_schema.
    return [
        {"column_name": name, "data_type": data_type, "is_nullable": "YES"}
        for name, data_type in pairs
    ]


def _conn(columns, rows) -> MagicMock:
    conn = MagicMock()
    bounded = [{**row, "__mirage_bytes": 100} for row in rows]
    conn.fetch = AsyncMock(
        side_effect=[columns, bounded or [{"__mirage_bytes": 0}]]
    )
    return conn


def _scanning_conn(columns, rows) -> MagicMock:
    # A search that reads the file asks for the columns, the size
    # estimate and then the rows through the whole read.
    conn = MagicMock()

    async def fetch(sql, *args):
        if "information_schema.columns" in sql:
            return columns
        if sql.startswith("EXPLAIN"):
            return [
                {"QUERY PLAN": [{"Plan": {"Plan Rows": 1, "Plan Width": 8}}]}
            ]
        if sql.startswith("WITH data AS MATERIALIZED"):
            return [{**row, "__mirage_bytes": 100} for row in rows]
        return rows

    conn.fetch = AsyncMock(side_effect=fetch)
    conn.fetchval = AsyncMock(
        return_value=[{"Plan": {"Plan Rows": 1, "Plan Width": 8}}]
    )
    return conn


def _query(pattern: str, ignore_case: bool = False) -> SearchQuery:
    return SearchQuery(
        query=pattern,
        options={"grep": {"ignore_case": ignore_case, "fixed_string": False}},
    )


USERS = _columns(("id", "integer"), ("name", "text"))


@pytest.mark.asyncio
@pytest.mark.parametrize("separator", ["\u0085", "\u2028", "\u2029"])
async def test_search_preserves_unicode_separators_inside_jsonl_rows(
    separator,
):
    conn = _scanning_conn(USERS, [{"id": 1, "name": f"left{separator}right"}])
    lines = await search_entity(
        _accessor_with_conn(conn), "public", "tables", "users", _query("name")
    )
    assert lines == [f'{{"id":1,"name":"left{separator}right"}}']


@pytest.mark.asyncio
async def test_search_entity_answers_the_lines_grep_would_print():
    conn = _conn(
        USERS, [{"id": 1, "name": "alice"}, {"id": 2, "name": "alex"}]
    )
    lines = await search_entity(
        _accessor_with_conn(conn), "public", "tables", "users", _query("al")
    )
    assert lines == ['{"id":1,"name":"alice"}', '{"id":2,"name":"alex"}']


@pytest.mark.asyncio
async def test_search_entity_casts_every_column_and_takes_escaped_rows():
    conn = _conn(USERS, [])
    await search_entity(
        _accessor_with_conn(conn),
        "public",
        "tables",
        "users",
        _query("user_id"),
    )
    sql, pattern, limit, max_bytes = conn.fetch.await_args_list[1].args
    # grep is case-sensitive by default, so the push-down uses LIKE; an
    # integer column is searched through its cast, which spells it the way
    # the line does; a string column holding a control character is a
    # candidate, since the line spells it as an escape.
    assert "ILIKE" not in sql
    assert '"id"::text LIKE $1' in sql
    assert '"name"::text LIKE $1' in sql
    assert "\"name\" ~ '[[:cntrl:]]'" in sql
    assert '"id" ~' not in sql
    assert pattern == "%user\\_id%"
    # One past the ceiling, to tell a full answer from a cut one.
    assert limit == 10_001
    assert max_bytes == 10 * 1024 * 1024
    assert "LEFT JOIN data ON budget.bytes <= $3" in sql


@pytest.mark.asyncio
@pytest.mark.parametrize("database_bytes", [65, 1])
async def test_search_refuses_database_and_rendered_byte_overflows(
    database_bytes,
):
    conn = _conn(USERS, [])
    conn.fetch.side_effect = [
        USERS,
        [
            {
                "name": "needle" + "x" * 1024,
                "__mirage_bytes": database_bytes,
            }
        ],
    ]
    accessor = _accessor_with_conn(conn)
    accessor.config = PostgresConfig(
        dsn="postgres://localhost/db", max_read_bytes=64
    )
    with pytest.raises(
        FileTooLargeError, match="public/tables/users/rows.jsonl"
    ):
        await search_entity(
            accessor, "public", "tables", "users", _query("needle")
        )


@pytest.mark.asyncio
async def test_search_entity_case_insensitive_uses_ilike():
    conn = _conn(USERS, [])
    await search_entity(
        _accessor_with_conn(conn),
        "public",
        "tables",
        "users",
        _query("ALI", ignore_case=True),
    )
    assert "ILIKE" in conn.fetch.await_args_list[1].args[0]


@pytest.mark.asyncio
async def test_search_entity_scans_a_candidate_with_the_real_matcher():
    # A tab renders as `\t` in the line, so `t` matches it there while no
    # LIKE over the value would: the row is a candidate and the matcher
    # decides, exactly as grep over rows.jsonl decides.
    body = _columns(("id", "integer"), ("body", "text"))
    conn = _conn(body, [{"id": 1, "body": "a\tb"}, {"id": 2, "body": "x\ny"}])
    lines = await search_entity(
        _accessor_with_conn(conn), "public", "tables", "t", _query("t")
    )
    assert lines == ['{"id":1,"body":"a\\tb"}']


ROW = {"id": 1, "rating": 4.5, "at": "2026", "name": None}


@pytest.mark.parametrize(
    ("columns", "pattern", "why"),
    [
        (
            _columns(("id", "integer"), ("rating", "double precision")),
            "4.5",
            "a double renders differently from its cast",
        ),
        (
            _columns(("id", "integer"), ("at", "timestamp with time zone")),
            "2026",
            "a timestamp renders differently from its cast",
        ),
        (
            _columns(("id", "integer"), ("code", "character")),
            "4.5",
            "char(n) pads, and its cast strips the padding",
        ),
        (
            _columns(("id", "integer"), ("doc", "jsonb")),
            "4.5",
            "jsonb's cast spaces its separators",
        ),
        (USERS, "am", "every row holds the key `name`"),
        (USERS, "ul", "a NULL spells `null` in the line"),
        (USERS, 'd":1', "a quote matches between key and value"),
        (USERS, ":1", "a colon matches between key and value"),
    ],
)
@pytest.mark.asyncio
async def test_search_entity_reads_the_file_when_a_like_cannot_answer(
    columns, pattern, why
):
    """The push-down printed its LIKE answer as grep's, and a LIKE per
    text column never sees a number, a key, the text between values, a
    NULL, or a value the line spells differently, so grep over rows.jsonl
    found rows the push-down did not. Such a search reads the file."""
    conn = _scanning_conn(columns, [ROW])
    lines = await search_entity(
        _accessor_with_conn(conn), "public", "tables", "t", _query(pattern)
    )
    assert lines == ['{"id":1,"rating":4.5,"at":"2026","name":null}'], why
    assert not any("LIKE" in c.args[0] for c in conn.fetch.await_args_list)


@pytest.mark.asyncio
async def test_search_entity_refuses_more_matches_than_one_read_returns():
    # It used to print the first `default_search_limit` matches and drop
    # the rest in silence.
    rows = [{"id": i, "name": "ada"} for i in range(4)]
    conn = _conn(USERS, rows)
    accessor = _accessor_with_conn(conn)
    accessor.config = PostgresConfig(
        dsn="postgres://localhost/db", max_read_rows=3
    )
    with pytest.raises(
        FileTooLargeError, match="public/tables/users/rows.jsonl"
    ):
        await search_entity(
            accessor, "public", "tables", "users", _query("ada")
        )


@pytest.mark.asyncio
async def test_search_entity_with_no_columns_matches_nothing():
    conn = _conn([], [])
    assert (
        await search_entity(
            _accessor_with_conn(conn), "public", "tables", "empty", _query("x")
        )
        == []
    )


@pytest.mark.asyncio
async def test_search_kind_iterates_tables():
    accessor = _accessor()
    with (
        patch("mirage.core.postgres.search.client") as mc,
        patch(
            "mirage.core.postgres.search.search_entity", new_callable=AsyncMock
        ) as mock_entity,
    ):
        mc.list_tables = AsyncMock(return_value=["t1", "t2", "t3"])
        mock_entity.side_effect = [['{"id":1}'], [], ['{"id":9}']]
        result = await search_kind(accessor, "public", "tables", _query("x"))
    assert result == [
        ("public", "tables", "t1", ['{"id":1}']),
        ("public", "tables", "t3", ['{"id":9}']),
    ]


@pytest.mark.asyncio
async def test_search_kind_views_unions_views_and_matviews():
    accessor = _accessor()
    with (
        patch("mirage.core.postgres.search.client") as mc,
        patch(
            "mirage.core.postgres.search.search_entity",
            new_callable=AsyncMock,
            return_value=[],
        ) as mock_entity,
    ):
        mc.list_views = AsyncMock(return_value=["v1"])
        mc.list_matviews = AsyncMock(return_value=["mv1"])
        await search_kind(accessor, "public", "views", _query("x"))
    called_entities = sorted(c.args[3] for c in mock_entity.await_args_list)
    assert called_entities == ["mv1", "v1"]


@pytest.mark.asyncio
async def test_search_schema_visits_both_kinds():
    accessor = _accessor()
    query = _query("x")
    with patch(
        "mirage.core.postgres.search.search_kind",
        new_callable=AsyncMock,
        side_effect=[
            [("public", "tables", "t1", ['{"id":1}'])],
            [("public", "views", "v1", ['{"id":2}'])],
        ],
    ) as mock_kind:
        result = await search_schema(accessor, "public", query)
    assert len(result) == 2
    assert mock_kind.await_args_list[0].args == (
        accessor,
        "public",
        "tables",
        query,
    )
    assert mock_kind.await_args_list[1].args == (
        accessor,
        "public",
        "views",
        query,
    )


@pytest.mark.asyncio
async def test_search_database_iterates_schemas():
    accessor = _accessor()
    with (
        patch("mirage.core.postgres.search.client") as mc,
        patch(
            "mirage.core.postgres.search.search_schema",
            new_callable=AsyncMock,
            side_effect=[
                [("public", "tables", "t1", ['{"id":1}'])],
                [("analytics", "tables", "t2", ['{"id":2}'])],
            ],
        ) as mock_schema,
    ):
        mc.list_schemas = AsyncMock(return_value=["public", "analytics"])
        result = await search_database(accessor, _query("x"))
    assert len(result) == 2
    assert mock_schema.await_count == 2


def test_format_grep_results():
    lines = format_grep_results(
        [
            ("public", "tables", "users", ['{"id":1,"name":"a"}']),
            ("public", "views", "v1", ['{"x":9}']),
        ]
    )
    assert [text for _, text in lines] == [
        'public/tables/users/rows.jsonl:{"id":1,"name":"a"}',
        'public/views/v1/rows.jsonl:{"x":9}',
    ]


def test_format_grep_results_empty():
    assert format_grep_results([]) == []
