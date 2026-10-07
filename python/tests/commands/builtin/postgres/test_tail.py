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
from mirage.commands.builtin.postgres.io import IO as BACKEND_IO
from mirage.commands.builtin.postgres.tail import tail
from mirage.commands.config import CommandOpts
from mirage.io.stream import materialize
from mirage.types import PathSpec
from mirage.vfs.postgres.config import PostgresConfig


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


async def _catalog_schemas(conn, allowlist):
    return [
        s for s in ("public", "secret") if allowlist is None or s in allowlist
    ]


@pytest.fixture
def catalog(monkeypatch):
    monkeypatch.setattr(
        "mirage.core.postgres.client.list_schemas",
        AsyncMock(side_effect=_catalog_schemas),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.list_tables",
        AsyncMock(return_value=["users"]),
    )


def _path(s: str) -> PathSpec:
    return PathSpec(virtual=s, directory=s, vfs_path=s.strip("/"))


@pytest.fixture
def table(monkeypatch, catalog):
    rows = [{"id": i} for i in range(1500)]

    async def fetch_rows(conn, schema, entity, *, limit, offset):
        return rows[offset : offset + limit]

    monkeypatch.setattr(
        "mirage.core.postgres.client.count_rows",
        AsyncMock(return_value=len(rows)),
    )
    monkeypatch.setattr(
        "mirage.core.postgres.client.fetch_rows",
        AsyncMock(side_effect=fetch_rows),
    )
    return rows


async def _tail(
    accessor: PostgresAccessor, n: int
) -> tuple[list[bytes], int, bytes]:
    out, io = await tail(
        BACKEND_IO,
        accessor,
        [_path("/public/tables/users/rows.jsonl")],
        [],
        CommandOpts(index=RAMIndexCacheStore(), flags={"n": str(n)}),
    )
    data = await materialize(out)
    return data.splitlines(), io.exit_code, await materialize(io.stderr)


@pytest.mark.asyncio
async def test_tail_prints_every_row_asked_for_past_the_default(table):
    """``default_row_limit`` clamped the suffix, so ``tail -n 1200`` of a
    1500-row table printed the last 1000 rows with exit 0."""
    lines, code, err = await _tail(_accessor(), 1200)
    assert len(lines) == 1200
    assert lines[-1] == b'{"id":1499}'
    assert (code, err) == (0, b"")
