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


from typing import Literal, TypedDict

from mirage.accessor.postgres import TEXT_TYPES, PostgresAccessor
from mirage.core.postgres import client
from mirage.core.postgres.client import qualified, quote_ident
from mirage.core.postgres.read import row_line
from mirage.core.postgres.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.json_canonical import canonicalize_row

# Types whose `::text` is the value exactly as a rows.jsonl line spells it,
# so a LIKE over the cast finds every row whose line holds the text inside
# that value. A date or time type's row keeps that text.
_SAME_TEXT_TYPES = frozenset(
    {"uuid", "int2", "int4", "int8", "bool", *TEXT_TYPES}
)
# The strings among them, which can hold a control character the line
# spells as an escape (`\n`, `\u0001`), so the text can match the escape's
# letters in a row whose value never holds them: such rows are candidates
# too. An enum's label is one as well.
_STRING_TYPES = frozenset({"text", "varchar", "name"})
# Array elements whose `::text` is each element as the line spells it.
_SAME_TEXT_ELEMENTS = _STRING_TYPES | frozenset(
    {"uuid", "int2", "int4", "int8", *TEXT_TYPES}
)
# Every character a value of these types spells in a line on either host
# (a float's exponent, a numeric's NaN or Infinity), folded to lowercase.
# A text holding any other character is never inside such a value, so the
# column is left out of the search.
_NUMBER = frozenset("0123456789.+-e")
_SPELLED_WITH = {
    "float4": _NUMBER,
    "float8": _NUMBER,
    "numeric": _NUMBER | frozenset("nainfty"),
}
# What a line spells around and between values: a text holding one can
# match where no single value holds it (`:4` after a key).
_STRUCTURAL = frozenset('"\\:,{}')
# How a NULL spells in the line; no LIKE over a NULL ever matches it.
_NULL = "null"
# Relations whose rows a plain read takes in ctid order: a table or a
# materialized view with no child. Any other (a view, a parent appending
# its children's rows) is numbered in the order a plain read returns it.
_HEAP_KINDS = frozenset({"r", "m"})
_RELATION = (
    "SELECT c.relkind::text AS relkind, c.relhassubclass FROM pg_class c "
    "JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE n.nspname = $1 AND c.relname = $2"
)
# Each column's type, a domain's base type in its place, with its category
# (E an enum, A an array) and an array's element type.
_COLUMNS = (
    "SELECT a.attname AS name, COALESCE(b.typname, t.typname) AS type, "
    "COALESCE(b.typcategory, t.typcategory)::text AS category, "
    "e.typname AS element FROM pg_attribute a "
    "JOIN pg_class c ON c.oid = a.attrelid "
    "JOIN pg_namespace n ON n.oid = c.relnamespace "
    "JOIN pg_type t ON t.oid = a.atttypid "
    "LEFT JOIN pg_type b ON b.oid = t.typbasetype "
    "LEFT JOIN pg_type e ON e.oid = COALESCE(b.typelem, t.typelem) "
    "WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 "
    "AND NOT a.attisdropped ORDER BY a.attnum"
)


class _Column(TypedDict):
    name: str
    type: str
    category: str
    element: str | None


_How = Literal["like", "string", "skip"]


def _escape_like(text: str) -> str:
    """Escape LIKE/ILIKE wildcards so the text matches as a literal.

    Postgres LIKE treats % and _ as wildcards and \\ as the default
    escape char; grep's text has no such meaning, so `user_id` must not
    match `userXid`.

    Args:
        text (str): the literal substring to match.
    """
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _column_search(column: _Column, text: str) -> _How | None:
    """How a LIKE covers one column: ``like`` over its cast, ``string``
    over its cast plus its rows holding a control character, ``skip`` when
    no value of it can spell ``text``, None when none of these sees every
    match.

    A ``char(n)`` pads its value and its cast strips the padding, so only
    a text without a space is covered. A jsonb value lines up with its cast
    except for a number the line may spell another way (a large one in
    exponent form), so a text that could lie inside a number, or that
    holds a bracket next to one, is not. An array's line brackets where its
    cast braces.

    Args:
        column (_Column): the column's name, type (a domain's base
            type), category (E an enum, A an array) and an array's
            element type.
        text (str): plain text every match holds.
    """
    data_type, category = column["type"], column["category"]
    element = column["element"]
    folded = set(text.lower())
    if data_type in _STRING_TYPES or category == "E":
        return "string"
    if data_type in _SAME_TEXT_TYPES:
        return "like"
    if data_type == "bpchar":
        return "string" if " " not in text else None
    if data_type == "jsonb":
        if "[" in text or "]" in text or folded <= _NUMBER:
            return None
        return "like"
    if category == "A":
        if element not in _SAME_TEXT_ELEMENTS or "[" in text or "]" in text:
            return None
        return "string" if element in _STRING_TYPES else "like"
    spelled = _SPELLED_WITH.get(data_type)
    if spelled is not None and not folded <= spelled:
        return "skip"
    return None


def _searches(
    columns: list[_Column], text: str, ignore_case: bool
) -> list[tuple[str, _How]] | None:
    """Each searched column and how, or None when a LIKE over the columns
    cannot find every line a scan would.

    A LIKE per column sees only values: a text that can match a key (every
    row holds every key), the text between values, a NULL's ``null`` or a
    value the line spells differently from its cast would be found by the
    scan and missed by the query.

    Args:
        columns (list[_Column]): the entity's columns in order, as
            ``_COLUMNS`` reads them.
        text (str): plain text every match holds.
        ignore_case (bool): whether case folds.
    """
    if any(ch in _STRUCTURAL or ord(ch) < 0x20 for ch in text):
        return None
    folded = text.lower() if ignore_case else text
    if folded in _NULL:
        return None
    searched: list[tuple[str, _How]] = []
    for column in columns:
        name = column["name"]
        if folded in (name.lower() if ignore_case else name):
            return None
        how = _column_search(column, text)
        if how is None:
            return None
        if how != "skip":
            searched.append((name, how))
    return searched


async def lines_containing(
    accessor: PostgresAccessor, path: PathSpec, text: str, ignore_case: bool
) -> bytes | None:
    """The lines of a relation's rows.jsonl that may hold ``text``.

    A LIKE (ILIKE under -i) over every column that can spell ``text``
    picks the rows whose value holds it, plus any row with a control
    character the line spells as an escape; grep matches each line
    itself. The rows come in the plain read's order: a keyed relation's
    in key order; a keyless table's in ctid order, the order the plain
    read scans the heap in, whatever plan the filter gets (an index or a
    parallel scan returns them otherwise); any other relation's numbered
    as a plain read returns them before the filter. None for any
    other file, when the columns or the text keep a LIKE from seeing every
    match (``_searches``), or past ``max_read_rows`` rows or
    ``max_read_bytes`` bytes, where reading the file refuses it as too
    large.

    Args:
        accessor (PostgresAccessor): backend handle.
        path (PathSpec): the file grep would read.
        text (str): plain text every match holds.
        ignore_case (bool): whether case folds.
    """
    match = detect_scope(path)
    if match.kind != "entity_rows":
        return None
    schema, entity = match.slots["schema"], match.slots["entity"]
    cfg = accessor.config
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        relation = await conn.fetch(_RELATION, schema, entity)
        if len(relation) != 1:
            return None
        columns = [
            _Column(
                name=c["name"],
                type=c["type"],
                category=c["category"],
                element=c["element"],
            )
            for c in await conn.fetch(_COLUMNS, schema, entity)
        ]
        if not columns:
            return None
        searched = _searches(columns, text, ignore_case)
        if searched is None:
            return None
        if not searched:
            return b""
        op = "ILIKE" if ignore_case else "LIKE"
        clauses = []
        for name, how in searched:
            clauses.append(f"{quote_ident(name)}::text {op} $1")
            if how == "string":
                clauses.append(f"{quote_ident(name)}::text ~ '[[:cntrl:]]'")
        names = {c["name"] for c in columns}
        source = qualified(schema, entity)
        where = " OR ".join(clauses)
        marker = "__mirage_row"
        while marker in names:
            marker += "_"
        pk = await client.fetch_row_key(conn, schema, entity)
        if pk:
            sql = (
                f"SELECT * FROM {source} WHERE {where}"
                f"{client.key_order(pk)} LIMIT $2"
            )
        elif (
            relation[0]["relkind"] in _HEAP_KINDS
            and not relation[0]["relhassubclass"]
        ):
            sql = (
                f"SELECT * FROM {source} WHERE {where} ORDER BY ctid LIMIT $2"
            )
        else:
            numbered = quote_ident(marker)
            sql = (
                f"SELECT * FROM (SELECT row_number() OVER () AS {numbered}, "
                f"r.* FROM {source} r) s WHERE {where} "
                f"ORDER BY {numbered} LIMIT $2"
            )
        rows = await client.fetch_bounded_query(
            conn,
            sql,
            [f"%{_escape_like(text)}%", cfg.max_read_rows + 1],
            names | {marker},
            cfg.max_read_bytes,
        )
    if rows is None or len(rows) > cfg.max_read_rows:
        return None
    body = bytearray()
    for row in rows:
        row.pop(marker, None)
        body.extend((row_line(canonicalize_row(row)) + "\n").encode())
        if len(body) > cfg.max_read_bytes:
            return None
    return bytes(body)
