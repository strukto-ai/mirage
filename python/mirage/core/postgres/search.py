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

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.postgres import client
from mirage.core.postgres.client import qualified, quote_ident
from mirage.core.postgres.read import row_line
from mirage.core.postgres.scope import detect_scope
from mirage.types import PathSpec

# Column types whose `::text` is the value exactly as a rows.jsonl line
# spells it, so a LIKE over the cast finds every row whose line holds
# the text inside that value. Everything else renders differently in
# the line (a timestamp's separator, a float's digits, a `char(n)`'s
# padding, json's spacing), and a table holding one is not searchable.
_SAME_TEXT_TYPES = frozenset(
    {
        "text",
        "character varying",
        "name",
        "uuid",
        "smallint",
        "integer",
        "bigint",
        "boolean",
    }
)
# The ones that can hold a control character, which the line spells as
# an escape (`\n`, `\u0001`), so the text can match the escape's letters
# in a row whose value never holds them: such rows are candidates too.
_STRING_TYPES = frozenset({"text", "character varying", "name"})
# What a line spells around and between values: a text holding one can
# match where no single value holds it (`:4` after a key).
_STRUCTURAL = frozenset('"\\:,{}')
# How a NULL spells in the line; no LIKE over a NULL ever matches it.
_NULL = "null"
# Relations whose rows a plain read takes in ctid order: a table or a
# materialized view with no child. A view runs its own query, and a
# parent appends its children's rows after its own.
_HEAP_KINDS = frozenset({"r", "m"})
_RELATION = (
    "SELECT c.relkind::text AS relkind, c.relhassubclass FROM pg_class c "
    "JOIN pg_namespace n ON n.oid = c.relnamespace "
    "WHERE n.nspname = $1 AND c.relname = $2"
)


def _escape_like(text: str) -> str:
    """Escape LIKE/ILIKE wildcards so the text matches as a literal.

    Postgres LIKE treats % and _ as wildcards and \\ as the default
    escape char; grep's text has no such meaning, so `user_id` must not
    match `userXid`.

    Args:
        text (str): the literal substring to match.
    """
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _answerable(
    columns: list[tuple[str, str]], text: str, ignore_case: bool
) -> bool:
    """Whether a LIKE over the columns finds every line a scan would.

    A LIKE per column sees only values: a text that can match a key
    (every row holds every key), the text between values, a NULL's
    ``null`` or a value the line spells differently from its cast would
    be found by the scan and missed by the query.

    Args:
        columns (list[tuple[str, str]]): the entity's ``(name, data type)``
            in column order.
        text (str): plain text every match holds.
        ignore_case (bool): whether case folds.
    """
    if any(ch in _STRUCTURAL or ord(ch) < 0x20 for ch in text):
        return False
    folded = text.lower() if ignore_case else text
    if folded in _NULL:
        return False
    for name, data_type in columns:
        if data_type not in _SAME_TEXT_TYPES:
            return False
        if folded in (name.lower() if ignore_case else name):
            return False
    return True


async def lines_containing(
    accessor: PostgresAccessor, path: PathSpec, text: str, ignore_case: bool
) -> bytes | None:
    """The lines of a table's rows.jsonl that may hold ``text``.

    A LIKE (ILIKE under -i) over every column picks the rows whose value
    holds ``text``, plus any row with a control character the line spells
    as an escape; grep matches each line itself. The rows come in ctid
    order, the order the plain read scans the heap in, whatever plan the
    filter gets (an index or a parallel scan returns them otherwise), so
    only a relation in ``_HEAP_KINDS`` with no child is searched. None
    for any other file or relation, when the columns or the text keep a
    LIKE from seeing every match (``_answerable``), or past
    ``max_read_rows`` rows or ``max_read_bytes`` bytes, where reading the
    file refuses it as too large.

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
        if (
            len(relation) != 1
            or relation[0]["relkind"] not in _HEAP_KINDS
            or relation[0]["relhassubclass"]
        ):
            return None
        columns = [
            (c["name"], c["type"])
            for c in await client.fetch_columns(conn, schema, entity)
        ]
        if not columns or not _answerable(columns, text, ignore_case):
            return None
        op = "ILIKE" if ignore_case else "LIKE"
        clauses = [f"{quote_ident(name)}::text {op} $1" for name, _ in columns]
        clauses += [
            f"{quote_ident(name)} ~ '[[:cntrl:]]'"
            for name, data_type in columns
            if data_type in _STRING_TYPES
        ]
        sql = (
            f"SELECT * FROM {qualified(schema, entity)} "
            f"WHERE {' OR '.join(clauses)} ORDER BY ctid LIMIT $2"
        )
        rows = await client.fetch_bounded_query(
            conn,
            sql,
            [f"%{_escape_like(text)}%", cfg.max_read_rows + 1],
            {name for name, _ in columns},
            cfg.max_read_bytes,
        )
    if rows is None or len(rows) > cfg.max_read_rows:
        return None
    body = bytearray()
    for row in rows:
        body.extend((row_line(row) + "\n").encode())
        if len(body) > cfg.max_read_bytes:
            return None
    return bytes(body)
