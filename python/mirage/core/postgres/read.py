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

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import asyncpg
import orjson

from mirage.accessor.postgres import PostgresAccessor
from mirage.core.hierarchy.read import make_read, per_kind
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.postgres import client
from mirage.core.postgres._schema_json import (
    build_database_json,
    build_entity_schema_json,
)
from mirage.core.postgres.readdir import entity_guard
from mirage.core.postgres.scope import detect_scope
from mirage.core.postgres.semantic import build_entity_semantic_json
from mirage.core.render.json import ecma_numbers
from mirage.errors.fs import efbig
from mirage.types import FileStat, PathSpec


def _entity_kind(match: ScopeMatch) -> str:
    return "table" if match.slots["kind"] == "tables" else "view"


async def _read_database_json(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
) -> bytes:
    doc = await build_database_json(accessor)
    return orjson.dumps(doc, option=orjson.OPT_INDENT_2)


async def _read_entity_schema(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    entry: FileStat | None,
    parent: FileStat | None,
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
    entry: FileStat | None,
    parent: FileStat | None,
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
    entry: FileStat | None,
    parent: FileStat | None,
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
    """One row as rows.jsonl spells it, each number as ECMAScript's
    ``Number::toString`` does (``number_text``), as TypeScript's
    ``JSON.stringify`` writes it.

    Args:
        row (dict[str, Any]): a canonicalized row.
    """
    return orjson.dumps(ecma_numbers(row), default=str).decode()


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


async def _first_rows(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    n: int,
) -> bytes:
    """The first ``n`` rows of a relation's rows.jsonl, by a ``LIMIT``.

    ``max_read_rows`` is the most rows one read may return, so a count
    past it fetches one row more than the ceiling and raises EFBIG when
    that row exists, as a whole read of a relation that long does; a
    relation shorter than the ceiling comes back whole.

    Args:
        accessor (PostgresAccessor): backend handle.
        match (ScopeMatch): the rows file's match.
        path (PathSpec): the file.
        n (int): how many rows, at least 1.
    """
    cap = accessor.config.max_read_rows
    data = await read_rows(
        accessor,
        match.slots["schema"],
        match.slots["entity"],
        path=path,
        limit=min(n, cap + 1),
    )
    if data.count(b"\n") > cap:
        raise efbig(path)
    return data


def _lines(rows: list[dict[str, Any]]) -> bytes:
    """Rows as their rows.jsonl lines.

    Args:
        rows (list[dict[str, Any]]): canonicalized rows.
    """
    return b"".join((row_line(row) + "\n").encode() for row in rows)


async def _last_rows(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    n: int,
) -> bytes:
    """The last ``n`` rows of a relation's rows.jsonl: off the end of its
    primary key where it has one, otherwise by a ``COUNT(*)`` and an
    ``OFFSET``.

    A suffix longer than ``max_read_rows`` raises EFBIG, as a whole read
    of a relation that long does.

    Args:
        accessor (PostgresAccessor): backend handle.
        match (ScopeMatch): the rows file's match.
        path (PathSpec): the file.
        n (int): how many rows, at least 1.
    """
    schema, entity = match.slots["schema"], match.slots["entity"]
    cap = accessor.config.max_read_rows
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        pk = await client.fetch_row_key(conn, schema, entity)
        if pk:
            rows, _ = await client.fetch_last_rows(
                conn, schema, entity, pk, min(n, cap + 1)
            )
            if len(rows) > cap:
                raise efbig(path)
            return _lines(rows)
        total = await client.count_rows(conn, schema, entity)
    limit = min(n, total)
    if limit > accessor.config.max_read_rows:
        raise efbig(path)
    if limit == 0:
        return b""
    return await read_rows(
        accessor, schema, entity, path=path, limit=limit, offset=total - limit
    )


async def _row_count(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
) -> int:
    """How many rows a relation holds, one line each in its rows.jsonl,
    by a ``COUNT(*)``.

    Args:
        accessor (PostgresAccessor): backend handle.
        match (ScopeMatch): the rows file's match.
        path (PathSpec): the file.
    """
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        return await client.count_rows(
            conn, match.slots["schema"], match.slots["entity"]
        )


async def read_stream(
    accessor: PostgresAccessor,
    path: PathSpec,
    parent: FileStat | None = None,
) -> AsyncIterator[bytes]:
    """Stream a keyed table's rows.jsonl a page of rows at a time, in key
    order, the next page fetched only when the caller pulls it; any other
    file, and a relation with no row key (``fetch_row_key``), comes
    whole, as :func:`read` gives it.

    A table past ``max_read_rows`` rows or ``max_read_bytes`` bytes
    raises EFBIG once that much is out, rather than refusing it whole: a
    stream cannot know a table's size before it has paged through it,
    and a reader that stops first (``head -c``, ``grep -l``) never
    reaches it. Each page asks for one row past what the row cap leaves
    and is sent only when it fits what the byte cap leaves, so no page
    holds more than the caps allow; a page that does not fit is asked
    again at half its rows, down to one row past the cap, so the rows
    that fit still come out before the refusal.

    Args:
        accessor (PostgresAccessor): backend handle.
        path (PathSpec): the file.
        parent (FileStat | None): its folder's row, which a whole read
            proves the file's folder by.
    """
    match = detect_scope(path)
    pk: list[str] = []
    if match.kind == "entity_rows":
        schema, entity = match.slots["schema"], match.slots["entity"]
        await entity_guard(accessor, match, path.virtual)
        pool = await accessor.pool()
        async with pool.acquire() as conn:
            pk = await client.fetch_row_key(conn, schema, entity)
            columns = await _column_names(conn, schema, entity)
    if not pk:
        yield await read(accessor, path, None, parent)
        return
    cfg = accessor.config
    rows_out = bytes_out = 0
    size = cfg.default_row_limit
    after: tuple[Any, ...] | None = None
    while True:
        limit = min(size, cfg.max_read_rows - rows_out + 1)
        async with pool.acquire() as conn:
            rows, after = await client.fetch_rows_after(
                conn,
                schema,
                entity,
                pk,
                after,
                limit,
                columns,
                cfg.max_read_bytes - bytes_out,
            )
        if rows is None:
            if limit == 1:
                raise efbig(path)
            size = limit // 2
            continue
        page = bytearray()
        for row in rows:
            line = (row_line(row) + "\n").encode()
            rows_out += 1
            bytes_out += len(line)
            if rows_out > cfg.max_read_rows or bytes_out > cfg.max_read_bytes:
                if page:
                    yield bytes(page)
                raise efbig(path)
            page.extend(line)
        if page:
            yield bytes(page)
        if len(rows) < limit:
            return


async def _column_names(
    conn: asyncpg.Connection, schema: str, entity: str
) -> set[str]:
    """A relation's column names, which a byte-bounded page keeps its
    size marker clear of.

    Args:
        conn (asyncpg.Connection): the connection.
        schema (str): the owning schema.
        entity (str): the relation.
    """
    return {
        c["name"] for c in await client.fetch_columns(conn, schema, entity)
    }


async def _follow_rows(
    accessor: PostgresAccessor,
    match: ScopeMatch,
    path: PathSpec,
    n: int,
    interval: float,
) -> AsyncIterator[bytes] | None:
    """A keyed table's last ``n`` rows, then each row whose key sorts
    past them, asked for every ``interval`` seconds. None for a relation
    with no primary key, whose rows have no end a new one lands at.

    The file lists rows in key order, so a row lands at its end exactly
    when its key sorts past the last one: each ask starts at the last
    key seen, and none is printed twice. A row whose key sorts before it
    lands in the middle of the file, where ``tail -f`` never looks.

    Args:
        accessor (PostgresAccessor): backend handle.
        match (ScopeMatch): the rows file's match.
        path (PathSpec): the file.
        n (int): how many of its last rows come first, 0 for none.
        interval (float): seconds between two asks.
    """
    schema, entity = match.slots["schema"], match.slots["entity"]
    cap = accessor.config.max_read_rows
    pool = await accessor.pool()
    async with pool.acquire() as conn:
        pk = await client.fetch_row_key(conn, schema, entity)
        if not pk:
            return None
        rows, after = await client.fetch_last_rows(
            conn, schema, entity, pk, max(min(n, cap + 1), 1)
        )
        columns = await _column_names(conn, schema, entity)
    if len(rows) > cap:
        raise efbig(path)
    return _followed_rows(
        accessor,
        path,
        pk,
        columns,
        after,
        rows[-n:] if n else [],
        interval,
    )


async def _followed_rows(
    accessor: PostgresAccessor,
    path: PathSpec,
    pk: list[str],
    columns: set[str],
    after: tuple[Any, ...] | None,
    rows: list[dict[str, Any]],
    interval: float,
) -> AsyncIterator[bytes]:
    """``rows``, then each row past ``after`` every ``interval`` seconds,
    as rows.jsonl lines. One ask whose rows pass ``max_read_bytes``
    raises EFBIG before any of them is sent.

    Args:
        accessor (PostgresAccessor): backend handle.
        path (PathSpec): the rows file.
        pk (list[str]): its table's row key.
        columns (set[str]): its table's column names.
        after (tuple[Any, ...] | None): the last key seen.
        rows (list[dict[str, Any]]): the last rows, printed first.
        interval (float): seconds between two asks.
    """
    if rows:
        yield _lines(rows)
    match = detect_scope(path)
    cfg = accessor.config
    pool = await accessor.pool()
    while True:
        await asyncio.sleep(interval)
        async with pool.acquire() as conn:
            added, after = await client.fetch_rows_after(
                conn,
                match.slots["schema"],
                match.slots["entity"],
                pk,
                after,
                cfg.default_row_limit,
                columns,
                cfg.max_read_bytes,
            )
        if added is None:
            raise efbig(path)
        if added:
            yield _lines(added)


first_lines = per_kind(
    detect_scope, {"entity_rows": _first_rows}, guard=entity_guard
)
last_lines = per_kind(
    detect_scope, {"entity_rows": _last_rows}, guard=entity_guard
)
line_count = per_kind(
    detect_scope, {"entity_rows": _row_count}, guard=entity_guard
)
follow = per_kind(
    detect_scope, {"entity_rows": _follow_rows}, guard=entity_guard
)


read = make_read(
    detect_scope,
    {
        "database_json": _read_database_json,
        "entity_schema": _read_entity_schema,
        "entity_semantic": _read_entity_semantic,
    },
    windowed={"entity_rows": _read_entity_rows},
    parented=True,
)
