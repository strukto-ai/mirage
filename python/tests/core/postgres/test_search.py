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
from unittest.mock import AsyncMock, MagicMock

import pytest

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres.search import lines_containing
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig

ROWS = "/public/tables/users/rows.jsonl"


@asynccontextmanager
async def _fake_acquire(conn):
    yield conn


def _accessor(conn, **config) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", **config)
    )
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire(conn)
    a.pool = AsyncMock(return_value=pool)
    return a


def _path(p: str = ROWS) -> PathSpec:
    return PathSpec(virtual=p, directory=p, vfs_path=p.strip("/"))


def _columns(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    # What `client.fetch_columns` reads off information_schema.
    return [
        {"column_name": name, "data_type": data_type, "is_nullable": "YES"}
        for name, data_type in pairs
    ]


def _conn(columns, rows, size: int = 100) -> MagicMock:
    conn = MagicMock()
    bounded = [{**row, "__mirage_bytes": size} for row in rows]
    conn.fetch = AsyncMock(
        side_effect=[columns, bounded or [{"__mirage_bytes": 0}]]
    )
    return conn


async def _lines(conn, text: str, ignore_case: bool = False, **config):
    return await lines_containing(
        _accessor(conn, **config), _path(), text, ignore_case
    )


USERS = _columns(("id", "integer"), ("name", "text"))


@pytest.mark.asyncio
async def test_answers_the_rows_holding_the_text_as_the_file_spells_them():
    conn = _conn(
        USERS, [{"id": 1, "name": "alice"}, {"id": 2, "name": "alex"}]
    )
    assert await _lines(conn, "al") == (
        b'{"id":1,"name":"alice"}\n{"id":2,"name":"alex"}\n'
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("separator", ["\u0085", "\u2028", "\u2029"])
async def test_keeps_unicode_separators_inside_a_line(separator):
    conn = _conn(USERS, [{"id": 1, "name": f"left{separator}right"}])
    assert await _lines(conn, "left") == (
        f'{{"id":1,"name":"left{separator}right"}}\n'.encode()
    )


@pytest.mark.asyncio
async def test_casts_every_column_and_takes_escaped_rows():
    conn = _conn(USERS, [])
    assert await _lines(conn, "user_id") == b""
    sql, pattern, limit, max_bytes = conn.fetch.await_args_list[1].args
    # grep is case-sensitive by default, so the query uses LIKE; an
    # integer column is searched through its cast, which spells it the
    # way the line does; a string column holding a control character is
    # a candidate, since the line spells it as an escape.
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
async def test_ignore_case_uses_ilike():
    conn = _conn(USERS, [])
    await _lines(conn, "ALI", ignore_case=True)
    assert '"name"::text ILIKE $1' in conn.fetch.await_args_list[1].args[0]


@pytest.mark.parametrize(
    ("columns", "text", "why"),
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
            "ab",
            "char(n) pads, and its cast strips the padding",
        ),
        (
            _columns(("id", "integer"), ("doc", "jsonb")),
            "ab",
            "jsonb's cast spaces its separators",
        ),
        (USERS, "am", "every row holds the key `name`"),
        (USERS, "ul", "a NULL spells `null` in the line"),
        (USERS, 'd":1', "a quote matches between key and value"),
        (USERS, ":1", "a colon matches between key and value"),
        (USERS, "a\tb", "a control character is spelled as an escape"),
        ([], "x", "no columns to ask"),
    ],
)
@pytest.mark.asyncio
async def test_declines_when_a_like_cannot_see_every_match(columns, text, why):
    conn = _conn(columns, [])
    assert await _lines(conn, text) is None, why
    assert len(conn.fetch.await_args_list) == 1


@pytest.mark.asyncio
async def test_declines_more_rows_than_a_read_returns():
    # Reading the file refuses it as too large, which only the read says.
    rows = [{"id": i, "name": "ada"} for i in range(4)]
    assert await _lines(_conn(USERS, rows), "ada", max_read_rows=3) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("database_bytes", [65, 1])
async def test_declines_database_and_rendered_byte_overflows(database_bytes):
    rows = [{"id": 1, "name": "needle" + "x" * 1024}]
    conn = _conn(USERS, rows, size=database_bytes)
    assert await _lines(conn, "needle", max_read_bytes=64) is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path", ["/public/tables/users/schema.json", "/public/tables/users"]
)
async def test_declines_any_other_file(path):
    conn = MagicMock()
    assert (
        await lines_containing(_accessor(conn), _path(path), "ada", False)
        is None
    )
