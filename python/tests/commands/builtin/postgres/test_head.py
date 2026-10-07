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
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.postgres.head import head
from mirage.commands.builtin.postgres.io import IO as BACKEND_IO
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig

ROWS = "/public/tables/users/rows.jsonl"


@asynccontextmanager
async def _fake_acquire():
    yield MagicMock()


def _accessor(**config) -> PostgresAccessor:
    a = PostgresAccessor(
        PostgresConfig(dsn="postgres://localhost/db", **config)
    )
    pool = MagicMock()
    pool.acquire = lambda: _fake_acquire()
    a.pool = AsyncMock(return_value=pool)
    return a


@pytest.fixture
def table(monkeypatch):
    """A visible ``public.users`` whose rows the fetch windows over."""
    rows: list[dict[str, int]] = []

    async def fetch_rows(conn, schema, entity, *, limit, offset):
        return rows[offset : offset + limit]

    monkeypatch.setattr(
        "mirage.core.postgres.client.list_schemas",
        AsyncMock(return_value=["public"]),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.list_tables",
        AsyncMock(return_value=["users"]),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.fetch_columns", AsyncMock(return_value=[])
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.estimated_row_count",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.table_size_bytes",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.fetch_rows",
        AsyncMock(side_effect=fetch_rows),
    )
    return rows


async def _head(
    accessor: PostgresAccessor, n: int
) -> tuple[bytes, int, bytes]:
    path = PathSpec(virtual=ROWS, directory=ROWS, vfs_path=ROWS.strip("/"))
    out, io = await head(
        BACKEND_IO,
        accessor,
        [path],
        [],
        CommandOpts(index=RAMIndexCacheStore(), flags={"lines": str(n)}),
    )
    data = await materialize(out)
    return data, io.exit_code, await materialize(io.stderr)


@pytest.mark.asyncio
async def test_head_prints_every_row_asked_for_past_the_default(table):
    """``default_row_limit`` clamped the pushed-down count, so ``head -n
    5000`` of a 6000-row table printed 1000 lines with exit 0."""
    table.extend({"id": i} for i in range(1500))
    data, code, err = await _head(_accessor(), 1200)
    assert len(data.splitlines()) == 1200
    assert (code, err) == (0, b"")


@pytest.mark.asyncio
async def test_head_past_the_ceiling_of_a_short_table_prints_it_whole(table):
    table.extend({"id": i} for i in range(15))
    data, code, err = await _head(_accessor(max_read_rows=20), 25)
    assert len(data.splitlines()) == 15
    assert (code, err) == (0, b"")
