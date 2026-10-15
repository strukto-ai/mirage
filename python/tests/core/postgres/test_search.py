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


def _columns(*specs: tuple[str, ...]) -> list[dict[str, str | None]]:
    # What `_COLUMNS` reads off the catalog: name, type, category and an
    # array's element type.
    return [
        {
            "name": spec[0],
            "type": spec[1],
            "category": spec[2] if len(spec) > 2 else "X",
            "element": spec[3] if len(spec) > 3 else None,
        }
        for spec in specs
    ]


TABLE = [{"relkind": "r", "relhassubclass": False}]


def _conn(columns, rows, size: int = 100, relation=TABLE, key=()) -> MagicMock:
    # The relation, then its columns, then its primary key, then the
    # bounded row query.
    conn = MagicMock()
    bounded = [{**row, "__mirage_bytes": size} for row in rows]
    conn.fetch = AsyncMock(
        side_effect=[
            relation,
            columns,
            [{"column_name": name} for name in key],
            bounded or [{"__mirage_bytes": 0}],
        ]
    )
    return conn


async def _lines(conn, text: str, ignore_case: bool = False, **config):
    return await lines_containing(
        _accessor(conn, **config), _path(), text, ignore_case
    )


USERS = _columns(("id", "int4"), ("name", "text"))


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
    sql, pattern, limit, max_bytes = conn.fetch.await_args_list[3].args
    # grep is case-sensitive by default, so the query uses LIKE; an
    # integer column is searched through its cast, which spells it the
    # way the line does; a string column holding a control character is
    # a candidate, since the line spells it as an escape.
    assert "ILIKE" not in sql
    assert '"id"::text LIKE $1' in sql
    assert '"name"::text LIKE $1' in sql
    assert "\"name\"::text ~ '[[:cntrl:]]'" in sql
    assert '"id"::text ~' not in sql
    assert pattern == "%user\\_id%"
    # One past the ceiling, to tell a full answer from a cut one.
    assert limit == 10_001
    assert max_bytes == 10 * 1024 * 1024
    assert "LEFT JOIN data ON budget.bytes <= $3" in sql
    # The order a plain read scans the heap in, whatever plan the filter
    # gets: an index or a parallel scan would hand rows over otherwise.
    assert "ORDER BY ctid LIMIT $2" in sql


@pytest.mark.asyncio
async def test_a_keyed_relation_comes_in_key_order():
    # The plain read lists a keyed relation in key order.
    conn = _conn(USERS, [], key=("id",))
    await _lines(conn, "ada")
    sql = conn.fetch.await_args_list[3].args[0]
    assert 'ORDER BY "id" LIMIT $2' in sql
    assert "ctid" not in sql


@pytest.mark.asyncio
async def test_ignore_case_uses_ilike():
    conn = _conn(USERS, [])
    await _lines(conn, "ALI", ignore_case=True)
    assert '"name"::text ILIKE $1' in conn.fetch.await_args_list[3].args[0]


@pytest.mark.parametrize(
    ("columns", "text", "why"),
    [
        (
            _columns(("id", "int4"), ("rating", "float8")),
            "4.5",
            "a double spells digits its cast may spell otherwise",
        ),
        (
            _columns(("id", "int4"), ("at", "timestamptz")),
            "2026",
            "a timestamp spells digits its cast spells otherwise",
        ),
        (
            _columns(("id", "int4"), ("price", "numeric")),
            "nan",
            "a numeric spells NaN",
        ),
        (
            _columns(("id", "int4"), ("code", "bpchar")),
            "a b",
            "char(n) pads, and its cast strips the padding",
        ),
        (
            _columns(("id", "int4"), ("doc", "jsonb")),
            "12",
            "a jsonb number may spell another way in the line",
        ),
        (
            _columns(("id", "int4"), ("doc", "jsonb")),
            "[a",
            "a bracket may sit next to a jsonb number",
        ),
        (
            _columns(("id", "int4"), ("tags", "_text", "A", "text")),
            "[a",
            "an array's line brackets where its cast braces",
        ),
        (
            _columns(("id", "int4"), ("flags", "_bool", "A", "bool")),
            "true",
            "a boolean array's cast spells t and f",
        ),
        (
            _columns(("id", "int4"), ("doc", "json")),
            "ab",
            "a json value's cast keeps escapes the line decodes",
        ),
        (
            _columns(("id", "int4"), ("span", "interval")),
            "ab",
            "an interval spells words on one host and keys on the other",
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
    assert len(conn.fetch.await_args_list) == 2


@pytest.mark.parametrize(
    ("column", "clauses"),
    [
        (("code", "bpchar"), ["LIKE", "~"]),
        (("doc", "jsonb"), ["LIKE"]),
        (("status", "mood", "E"), ["LIKE", "~"]),
        (("tags", "_text", "A", "text"), ["LIKE", "~"]),
        (("ids", "_int4", "A", "int4"), ["LIKE"]),
        (("label", "text"), ["LIKE", "~"]),
    ],
)
@pytest.mark.asyncio
async def test_searches_a_column_whose_cast_holds_the_text(column, clauses):
    # A char(n) without a space in the text, a jsonb value, an enum's
    # label and an array of strings or integers hold the text where their
    # cast does; a string can also hold it as an escape's letters.
    conn = _conn(_columns(column), [])
    assert await _lines(conn, "ada") == b""
    sql = conn.fetch.await_args_list[3].args[0]
    name = f'"{column[0]}"::text'
    assert [op for op in ("LIKE", "~") if f"{name} {op}" in sql] == clauses


@pytest.mark.asyncio
async def test_leaves_out_a_column_that_cannot_spell_the_text():
    # A float, a numeric, a date or a time spells digits and a few marks,
    # never the letters of `ada`, so only the other columns are asked.
    conn = _conn(
        _columns(
            ("id", "int4"),
            ("name", "text"),
            ("rating", "float8"),
            ("price", "numeric"),
            ("at", "timestamptz"),
        ),
        [{"id": 1, "name": "ada", "rating": 4.5, "price": 1, "at": None}],
    )
    assert await _lines(conn, "ada") == (
        b'{"id":1,"name":"ada","rating":4.5,"price":1,"at":null}\n'
    )
    sql = conn.fetch.await_args_list[3].args[0]
    assert '"name"::text LIKE' in sql
    assert '"rating"' not in sql and '"price"' not in sql
    assert '"at"' not in sql


@pytest.mark.asyncio
async def test_answers_nothing_when_no_column_can_spell_the_text():
    conn = _conn(_columns(("rating", "float8"), ("at", "date")), [])
    assert await _lines(conn, "ada") == b""
    assert len(conn.fetch.await_args_list) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "relation",
    [
        [{"relkind": "v", "relhassubclass": False}],
        [{"relkind": "p", "relhassubclass": True}],
        [{"relkind": "r", "relhassubclass": True}],
    ],
)
async def test_numbers_a_relation_read_in_another_order(relation):
    # A view runs its own query and a parent appends its children's rows,
    # so the rows are numbered in the order a plain read returns them,
    # before the filter, and the number never reaches the line.
    conn = _conn(
        USERS, [{"__mirage_row": 3, "id": 1, "name": "ada"}], relation=relation
    )
    assert await _lines(conn, "ada") == b'{"id":1,"name":"ada"}\n'
    sql = conn.fetch.await_args_list[3].args[0]
    assert 'row_number() OVER () AS "__mirage_row", r.*' in sql
    assert 'ORDER BY "__mirage_row" LIMIT $2' in sql
    assert "ctid" not in sql


@pytest.mark.asyncio
async def test_declines_a_relation_it_cannot_find():
    conn = _conn(USERS, [], relation=[])
    assert await _lines(conn, "ada") is None
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
